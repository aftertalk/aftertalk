import asyncio

import httpx2
import pytest

from aftertalk.providers.net import make_client


def ok_transport(seen: list[httpx2.Request]) -> httpx2.MockTransport:
    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, json={"ok": True})

    return httpx2.MockTransport(handler)


def resolver_for(mapping: dict[str, list[str]]):
    async def resolve(host: str, port: int) -> list[str]:
        return mapping.get(host, [host])

    return resolve


async def test_connection_is_pinned_to_the_validated_address() -> None:
    answers = iter([["93.184.216.34"], ["169.254.169.254"]])

    async def rebinding(host: str, port: int) -> list[str]:
        return next(answers)

    seen: list[httpx2.Request] = []
    async with make_client(block_private=True, resolver=rebinding, inner=ok_transport(seen)) as client:
        response = await client.get("https://api.example.com/v1/chat")
    assert response.status_code == 200
    (request,) = seen
    assert request.url.host == "93.184.216.34"  # what the inner transport connects to
    assert request.headers["host"] == "api.example.com"
    assert request.extensions["sni_hostname"] == "api.example.com"  # TLS verifies the original name


async def test_pinned_ipv6_address_is_bracketed_and_port_kept() -> None:
    seen: list[httpx2.Request] = []
    resolver = resolver_for({"v6.example.com": ["2606:2800:220:1:248:1893:25c8:1946"]})
    async with make_client(block_private=True, resolver=resolver, inner=ok_transport(seen)) as client:
        await client.get("http://v6.example.com:8080/x?q=1")
    (request,) = seen
    assert str(request.url) == "http://[2606:2800:220:1:248:1893:25c8:1946]:8080/x?q=1"
    assert request.headers["host"] == "v6.example.com:8080"


async def test_next_address_is_tried_when_connecting_fails() -> None:
    tried: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        tried.append(request.url.host)
        if request.url.host == "93.184.216.34":
            raise httpx2.ConnectError("refused")
        return httpx2.Response(200)

    resolver = resolver_for({"two.example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]})
    async with make_client(block_private=True, resolver=resolver, inner=httpx2.MockTransport(handler)) as client:
        assert (await client.get("http://two.example.com/")).status_code == 200
    assert tried[0] == "93.184.216.34" and len(tried) == 2


async def test_slow_name_resolution_times_out() -> None:
    async def slow(host: str, port: int) -> list[str]:
        await asyncio.sleep(5)
        return ["93.184.216.34"]

    async with make_client(block_private=True, connect_timeout=0.05, resolver=slow, inner=ok_transport([])) as client:
        with pytest.raises(httpx2.ConnectTimeout):
            await client.get("https://slow.example.com/")
