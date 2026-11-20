import json

import httpx2
import pytest
from fake_llm import FakeLLM

from aftertalk.providers.net import BlockedAddressError, make_client


def resolver_for(mapping: dict[str, list[str]]):
    async def resolve(host: str, port: int) -> list[str]:
        return mapping.get(host, [host])

    return resolve


def ok_transport(seen: list[httpx2.Request] | None = None) -> httpx2.MockTransport:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if seen is not None:
            seen.append(request)
        return httpx2.Response(200, json={"ok": True})

    return httpx2.MockTransport(handler)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "240.0.0.1",
        "::1",
        "::",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",
        "64:ff9b::a9fe:a9fe",
        "fd00::1",
        "fe80::1",
        "ff02::1",
    ],
)
async def test_private_addresses_are_blocked(ip: str) -> None:
    seen: list[httpx2.Request] = []
    client = make_client(block_private=True, resolver=resolver_for({"api.example.com": [ip]}), inner=ok_transport(seen))
    async with client:
        with pytest.raises(BlockedAddressError):
            await client.get("https://api.example.com/v1/chat")
    assert seen == []


async def test_any_private_answer_blocks_even_if_another_is_public() -> None:
    resolver = resolver_for({"mixed.example.com": ["93.184.216.34", "10.0.0.5"]})
    async with make_client(block_private=True, resolver=resolver, inner=ok_transport()) as client:
        with pytest.raises(BlockedAddressError):
            await client.get("https://mixed.example.com/")


@pytest.mark.parametrize("host", ["localhost", "LOCALHOST", "app.localhost", "foo.internal", "a.b.internal"])
async def test_local_hostnames_are_blocked_without_resolving(host: str) -> None:
    async def never(host: str, port: int) -> list[str]:
        raise AssertionError("must not resolve")

    async with make_client(block_private=True, resolver=never, inner=ok_transport()) as client:
        with pytest.raises(BlockedAddressError):
            await client.get(f"http://{host}:8080/")


@pytest.mark.parametrize("url", ["http://127.0.0.1:9/", "http://[::1]:9/", "http://[::ffff:127.0.0.1]:9/"])
async def test_ip_literals_are_blocked(url: str) -> None:
    async with make_client(block_private=True, inner=ok_transport()) as client:
        with pytest.raises(BlockedAddressError):
            await client.get(url)


async def test_public_address_is_allowed() -> None:
    seen: list[httpx2.Request] = []
    resolver = resolver_for({"api.example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]})
    async with make_client(block_private=True, resolver=resolver, inner=ok_transport(seen)) as client:
        response = await client.get("https://api.example.com/v1/chat")
    assert response.status_code == 200 and len(seen) == 1


async def test_checked_on_every_request() -> None:
    answers = {"flip.example.com": ["93.184.216.34"]}
    async with make_client(block_private=True, resolver=resolver_for(answers), inner=ok_transport()) as client:
        assert (await client.get("https://flip.example.com/")).status_code == 200
        answers["flip.example.com"] = ["127.0.0.1"]
        with pytest.raises(BlockedAddressError):
            await client.get("https://flip.example.com/")


async def test_unresolvable_host_is_a_transport_error() -> None:
    async def fail(host: str, port: int) -> list[str]:
        raise OSError("no such host")

    async with make_client(block_private=True, resolver=fail, inner=ok_transport()) as client:
        with pytest.raises(httpx2.ConnectError):
            await client.get("https://nope.example.com/")


async def test_blocking_off_allows_loopback(fake_llm: FakeLLM) -> None:
    async with make_client(block_private=False) as client:
        response = await client.post(f"{fake_llm.base_url}/chat/completions", json={"messages": []})
    assert response.status_code == 200


async def test_redirects_are_not_followed(fake_llm: FakeLLM) -> None:
    fake_llm.redirect_to = "http://127.0.0.1:1/elsewhere"
    async with make_client(block_private=False) as client:
        assert client.follow_redirects is False
        response = await client.post(f"{fake_llm.base_url}/chat/completions", json={"messages": []})
    assert response.status_code == 302
    assert len(fake_llm.seen) == 1


async def test_timeouts() -> None:
    client = make_client(block_private=False, timeout=30, connect_timeout=2)
    async with client:
        assert client.timeout.connect == 2 and client.timeout.read == 30


async def test_blocked_request_logs_the_fixed_fields(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("DEBUG", logger="aftertalk")
    async with make_client(block_private=True, inner=ok_transport()) as client:
        with pytest.raises(BlockedAddressError):
            await client.get("http://169.254.169.254/latest/meta-data")
    record = next(r for r in caplog.records if r.getMessage() == "provider address blocked")
    assert record.fields["error_code"] == "provider_unreachable"  # type: ignore[attr-defined]
    assert "step" in record.fields  # type: ignore[attr-defined]
    assert "169.254" not in json.dumps(record.fields)  # type: ignore[attr-defined]
    assert "169.254" not in caplog.text
