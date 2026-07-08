/**
 * CIDR 工具单测（issue #102）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  ipv4ToInt,
  isBannedIp,
  isValidIpOrCidr,
  parseCidr,
} from "../../src/lib/cidr.ts";

Deno.test("cidr: ipv4ToInt 正常 IP", () => {
  assertEquals(ipv4ToInt("1.2.3.4"), 0x01020304);
  assertEquals(ipv4ToInt("0.0.0.0"), 0);
  assertEquals(ipv4ToInt("255.255.255.255"), 0xffffffff);
});

Deno.test("cidr: ipv4ToInt 非法 IP 返 null", () => {
  assertEquals(ipv4ToInt("abc"), null);
  assertEquals(ipv4ToInt("1.2.3.999"), null);
  assertEquals(ipv4ToInt(""), null);
  assertEquals(ipv4ToInt("1.2.3"), null);
});

Deno.test("cidr: parseCidr 裸 IP 等价 /32", () => {
  const r = parseCidr("1.2.3.4");
  assertEquals(r?.base, 0x01020304);
  assertEquals(r?.mask, 0xffffffff);
});

Deno.test("cidr: parseCidr CIDR 范围", () => {
  const r = parseCidr("10.0.0.0/8");
  assertEquals(r?.base, 0x0a000000);
  assertEquals(r?.mask, 0xff000000);
});

Deno.test("cidr: parseCidr /0 是全网（应被 isValidIpOrCidr 拒绝）", () => {
  const r = parseCidr("0.0.0.0/0");
  assertEquals(r?.mask, 0);
  assertEquals(isValidIpOrCidr("0.0.0.0/0"), false);
});

Deno.test("cidr: isValidIpOrCidr 拒绝非法输入", () => {
  assertEquals(isValidIpOrCidr("abc"), false);
  assertEquals(isValidIpOrCidr("1.2.3"), false);
  assertEquals(isValidIpOrCidr("1.2.3.999"), false);
  assertEquals(isValidIpOrCidr("1.2.3.4/33"), false);
  assertEquals(isValidIpOrCidr(""), false);
});

Deno.test("cidr: isValidIpOrCidr 接受合法值", () => {
  assertEquals(isValidIpOrCidr("1.2.3.4"), true);
  assertEquals(isValidIpOrCidr("10.0.0.0/8"), true);
  assertEquals(isValidIpOrCidr("192.168.1.0/24"), true);
});

Deno.test("cidr: isBannedIp 裸 IP 命中", () => {
  assertEquals(isBannedIp("1.2.3.4", ["1.2.3.4"]), true);
  assertEquals(isBannedIp("5.6.7.8", ["1.2.3.4"]), false);
});

Deno.test("cidr: isBannedIp CIDR 范围匹配", () => {
  assertEquals(isBannedIp("10.5.3.7", ["10.0.0.0/8"]), true);
  assertEquals(isBannedIp("11.0.0.1", ["10.0.0.0/8"]), false);
  assertEquals(isBannedIp("192.168.1.100", ["192.168.1.0/24"]), true);
});

Deno.test("cidr: isBannedIp 多个范围任一命中", () => {
  assertEquals(
    isBannedIp("192.168.5.1", ["1.2.3.4", "10.0.0.0/8", "192.168.0.0/16"]),
    true,
  );
  assertEquals(
    isBannedIp("172.16.0.1", ["1.2.3.4", "10.0.0.0/8", "192.168.0.0/16"]),
    false,
  );
});

Deno.test("cidr: isBannedIp 非法 clientIp 永不命中", () => {
  assertEquals(isBannedIp("", ["1.2.3.4"]), false);
  assertEquals(isBannedIp("unknown", ["1.2.3.4"]), false);
  assertEquals(isBannedIp("not-an-ip", ["1.2.3.4"]), false);
});
