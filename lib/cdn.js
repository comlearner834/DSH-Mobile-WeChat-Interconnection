// cdn.js — 微信 CDN 图片/文件下载与 AES-128-ECB 解密（移植自官方 openclaw-weixin）。
"use strict";

import { createDecipheriv } from "node:crypto";

export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`aes_key 解码失败: ${aesKeyBase64} -> ${decoded.length} bytes`);
}

async function fetchCdnBytes(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`CDN 下载失败 ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 下载并解密微信 CDN 媒体，返回明文 Buffer。
 * @param {object} media - image_item.media (CDNMedia)
 * @param {object} item  - image_item 本身（优先取 item.aeskey 十六进制 key）
 * @param {string} [cdnBaseUrl]
 */
export async function downloadImageBuffer(media, item, cdnBaseUrl = CDN_BASE_URL) {
  if (!media?.encrypt_query_param && !media?.full_url) {
    throw new Error("media 缺少 encrypt_query_param / full_url");
  }
  const aesKeyBase64 = item?.aeskey
    ? Buffer.from(item.aeskey, "hex").toString("base64")
    : media.aes_key;
  const url = media.full_url || `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  const encrypted = await fetchCdnBytes(url);
  if (!aesKeyBase64) return encrypted; // 无密钥则返回原样字节（可能本身就是明文）
  const key = parseAesKey(aesKeyBase64);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
