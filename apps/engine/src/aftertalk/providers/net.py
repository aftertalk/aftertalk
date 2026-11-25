"""The HTTP client every provider call goes through, with an optional guard against private addresses.

With `BLOCK_PRIVATE_ADDRESSES` on, the client resolves each request's host itself and refuses it when any
answer is private, loopback, link-local, multicast, reserved or unspecified (also as an IPv4-mapped, NAT64 or
6to4 address). Redirects are never followed, so a public server cannot bounce a request to an internal one.

The connection is pinned: the request goes to the address that passed the check, with the original name as
`Host` and TLS server name, so a second DNS answer (DNS rebinding) cannot change where it connects.
"""

import asyncio
import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable

import httpx2
from pydantic_ai.models import create_async_httpx2_client

from aftertalk.logging import log
from aftertalk.models.errors import EngineError

Resolver = Callable[[str, int], Awaitable[list[str]]]

_IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_LOCAL_SUFFIXES = (".localhost", ".internal")
_LIMITS = httpx2.Limits(max_connections=1000, max_keepalive_connections=100)

# HTTP clients log every request URL at INFO and more at DEBUG. A presigned upload URL carries its signature, so these
# loggers only ever pass warnings and errors, whatever logging the process sets up (`logging.setup_logging` too).
for _name in ("httpx", "httpx2", "httpcore", "httpcore2"):
    logging.getLogger(_name).setLevel(logging.WARNING)


class BlockedAddressError(Exception):
    """The request's host is a private or local address. Mapped to `provider_unreachable`."""

    def __init__(self) -> None:
        super().__init__("provider address blocked")


def is_blocked_host(host: str) -> bool:
    name = host.lower().rstrip(".")
    return name == "localhost" or name.endswith(_LOCAL_SUFFIXES)


def is_blocked_ip(ip: _IPAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_blocked_ip(ip.ipv4_mapped)
        if ip in _NAT64:
            return is_blocked_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
        if ip.sixtofour is not None and is_blocked_ip(ip.sixtofour):
            return True
        if ip.teredo is not None and any(is_blocked_ip(part) for part in ip.teredo):
            return True
    return (
        not ip.is_global
        or ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


async def _resolve(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


def _interleave(addresses: list[str]) -> list[str]:
    """The first address, then the first of the other family, then the rest: a dead family costs one timeout."""
    if not addresses:
        return addresses
    first_v6 = ":" in addresses[0]
    other = next((a for a in addresses[1:] if (":" in a) != first_v6), None)
    if other is None:
        return addresses
    return [addresses[0], other, *(a for a in addresses[1:] if a != other)]


class _GuardedTransport(httpx2.AsyncBaseTransport):
    """Resolves the host, validates every answer, then connects to a validated address, not to the name."""

    def __init__(self, inner: httpx2.AsyncBaseTransport, resolver: Resolver, resolve_timeout: float) -> None:
        self._inner = inner
        self._resolver = resolver
        self._resolve_timeout = resolve_timeout

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        host = request.url.host
        addresses = _interleave(await self._validated_addresses(request.url))
        last: httpx2.ConnectError | httpx2.ConnectTimeout | None = None
        for address in addresses:
            # The inner transport connects to the IP we validated, so a second DNS answer cannot redirect it.
            # `Host` stays the original name, and `sni_hostname` makes TLS check the certificate against the
            # original name (httpcore passes it as `server_hostname` to the TLS handshake).
            pinned = httpx2.Request(
                request.method,
                request.url.copy_with(host=address),
                headers=request.headers,
                stream=request.stream,
                extensions={**request.extensions, "sni_hostname": host},
            )
            try:
                return await self._inner.handle_async_request(pinned)
            except (httpx2.ConnectError, httpx2.ConnectTimeout) as exc:
                # Both happen before any body byte is sent, so the request stream is still unread.
                last = exc
        assert last is not None
        raise last

    async def _validated_addresses(self, url: httpx2.URL) -> list[str]:
        host = url.host
        if is_blocked_host(host):
            raise self._blocked()
        port = url.port or (443 if url.scheme == "https" else 80)
        try:
            addresses = await asyncio.wait_for(self._resolver(host, port), self._resolve_timeout)
        except TimeoutError:
            raise httpx2.ConnectTimeout("name resolution timed out") from None
        except OSError:
            raise httpx2.ConnectError("name resolution failed") from None
        if not addresses:
            raise httpx2.ConnectError("name resolution failed")
        clean: list[str] = []
        for address in addresses:
            text = address.split("%", 1)[0]
            try:
                ip = ipaddress.ip_address(text)
            except ValueError:
                raise self._blocked() from None
            if is_blocked_ip(ip):
                raise self._blocked()
            if text not in clean:
                clean.append(text)
        return clean

    @staticmethod
    def _blocked() -> BlockedAddressError:
        # The address is not logged: it would show which internal hosts exist.
        log("warning", "provider address blocked", step="provider_request", error_code="provider_unreachable")
        return BlockedAddressError()

    async def aclose(self) -> None:
        await self._inner.aclose()


def make_client(
    *,
    block_private: bool,
    timeout: float = 600,
    connect_timeout: float = 5,
    resolver: Resolver | None = None,
    inner: httpx2.AsyncBaseTransport | None = None,
    proxy: str | None = None,
) -> httpx2.AsyncClient:
    """A client for provider calls. `resolver` and `inner` exist for tests.

    The environment is never trusted: `HTTP_PROXY`, `ALL_PROXY`, `.netrc` and `SSL_CERT_FILE` are ignored. The only
    proxy is the explicit `proxy` (setting `PROVIDER_PROXY`), and it is refused together with the private-address
    guard, because a proxy would resolve and connect to the host itself and so get around the guard.
    """
    if block_private and proxy:
        log(
            "error",
            "a provider proxy cannot be used with BLOCK_PRIVATE_ADDRESSES",
            error_code="provider_config_invalid",
        )
        raise EngineError("provider_config_invalid")
    transport: httpx2.AsyncBaseTransport | None = inner
    if transport is None:
        transport = httpx2.AsyncHTTPTransport(limits=_LIMITS, trust_env=False, proxy=proxy)
    if block_private:
        transport = _GuardedTransport(transport, resolver or _resolve, connect_timeout)
    client = create_async_httpx2_client(timeout=httpx2.Timeout(timeout, connect=connect_timeout), transport=transport)
    client._trust_env = False  # no netrc credentials from the environment either
    client.follow_redirects = False
    return client
