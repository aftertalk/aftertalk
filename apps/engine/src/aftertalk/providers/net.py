"""The HTTP client every provider call goes through, with an optional guard against private addresses.

With `BLOCK_PRIVATE_ADDRESSES` on, the client resolves each request's host itself and refuses it when any
answer is private, loopback, link-local, multicast, reserved or unspecified (also as an IPv4-mapped, NAT64 or
6to4 address). Redirects are never followed, so a public server cannot bounce a request to an internal one.

Known gap: the check resolves the name, then the transport resolves it again to connect. A DNS server that
answers differently the second time (DNS rebinding) can slip past. Pinning the connection to the validated
address is out of scope here; the check still stops configuration mistakes and plain SSRF attempts.
"""

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable

import httpx2
from pydantic_ai.models import create_async_httpx2_client

from aftertalk.logging import log

Resolver = Callable[[str, int], Awaitable[list[str]]]

_IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_LOCAL_SUFFIXES = (".localhost", ".internal")
_LIMITS = httpx2.Limits(max_connections=1000, max_keepalive_connections=100)


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


class _GuardedTransport(httpx2.AsyncBaseTransport):
    def __init__(self, inner: httpx2.AsyncBaseTransport, resolver: Resolver) -> None:
        self._inner = inner
        self._resolver = resolver

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        await self._check(request.url)
        return await self._inner.handle_async_request(request)

    async def _check(self, url: httpx2.URL) -> None:
        host = url.host
        if is_blocked_host(host):
            raise self._blocked()
        port = url.port or (443 if url.scheme == "https" else 80)
        try:
            addresses = await self._resolver(host, port)
        except OSError:
            raise httpx2.ConnectError("name resolution failed") from None
        if not addresses:
            raise httpx2.ConnectError("name resolution failed")
        for address in addresses:
            try:
                ip = ipaddress.ip_address(address.split("%", 1)[0])
            except ValueError:
                raise self._blocked() from None
            if is_blocked_ip(ip):
                raise self._blocked()

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
) -> httpx2.AsyncClient:
    """A client for provider calls. `resolver` and `inner` exist for tests."""
    transport: httpx2.AsyncBaseTransport | None = inner
    if block_private:
        transport = _GuardedTransport(inner or httpx2.AsyncHTTPTransport(limits=_LIMITS), resolver or _resolve)
    client = create_async_httpx2_client(timeout=httpx2.Timeout(timeout, connect=connect_timeout), transport=transport)
    client.follow_redirects = False
    return client
