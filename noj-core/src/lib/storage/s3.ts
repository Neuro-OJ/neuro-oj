/**
 * S3StorageProvider — S3 兼容对象存储实现
 *
 * 使用 `@aws-sdk/client-s3` 和 `@aws-sdk/s3-request-presigner`。
 * 支持 MinIO 等 S3 兼容存储。
 *
 * URL 格式：
 *   DB 存储：`noj-storage://s3/<key>?checksum_sha256=<hex>`
 *   Judge 交付：`noj-download://s3?url=[percent-encoded-presigned-URL]&checksum_sha256=<hex>`
 *
 * @module
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "npm:@aws-sdk/client-s3@^3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@^3";
import { sha256 } from "npm:@noble/hashes@2.2.0/sha2.js";

import {
  buildS3DownloadUrl,
  buildStorageUrl,
  parseStorageUrl,
  sha256Hex,
  type StorageProvider,
  validateStorageKey,
} from "./types.ts";
import { logger } from "../logging.ts";

/** S3StorageProvider 构造配置 */
export interface S3StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

/**
 * S3 兼容对象存储实现
 *
 * put() 计算 SHA-256 并存入 S3，返回 `noj-storage://s3/` URL
 * downloadUrl() 生成 presigned GET URL，返回 `noj-download://s3` URL
 */
export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  /**
   * @param config S3 连接配置
   * @param client 可选注入的 S3 客户端（测试用；缺省时按 config 新建）
   */
  constructor(config: S3StorageConfig, client?: S3Client) {
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
    this.bucket = config.bucket;
  }

  /**
   * 存储数据到 S3
   *
   * 1. 计算 SHA-256 哈希
   * 2. 使用指定 key 存入 S3
   * 3. 返回 `noj-storage://s3/<key>?checksum_sha256=<hex>`
   */
  async put(
    key: string,
    data: Uint8Array,
    contentType?: string,
  ): Promise<string> {
    validateStorageKey(key);
    const hashHex = await sha256Hex(data);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType || "application/zip",
        Metadata: {
          "checksum-sha256": hashHex,
        },
      }),
    );

    return buildStorageUrl("s3", key, hashHex);
  }

  /**
   * 流式存储数据到 S3（multipart upload）。
   *
   * 使用固定 5MB 分片缓冲，内存占用 O(1)；边传边计算 SHA-256。
   */
  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    contentType?: string,
    maxSizeBytes?: number,
  ): Promise<string> {
    validateStorageKey(key);
    const hash = sha256.create();
    const create = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType || "application/zip",
      }),
    );
    const uploadId = create.UploadId;
    if (!uploadId) {
      throw new Error("S3 CreateMultipartUpload 未返回 UploadId");
    }

    const PART_SIZE = 5 * 1024 * 1024;
    let partNumber = 1;
    let total = 0;
    let buffer = new Uint8Array(PART_SIZE);
    let bufferLen = 0;
    const uploadedParts: { PartNumber: number; ETag: string }[] = [];
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          total += value.length;
          if (maxSizeBytes !== undefined && total > maxSizeBytes) {
            throw new Error(`文件超过大小限制（${maxSizeBytes} 字节）`);
          }
          hash.update(value);
          let offset = 0;
          while (offset < value.length) {
            const copy = Math.min(PART_SIZE - bufferLen, value.length - offset);
            buffer.set(value.subarray(offset, offset + copy), bufferLen);
            bufferLen += copy;
            offset += copy;
            if (bufferLen === PART_SIZE) {
              const part = await this.client.send(
                new UploadPartCommand({
                  Bucket: this.bucket,
                  Key: key,
                  UploadId: uploadId,
                  PartNumber: partNumber,
                  Body: buffer,
                }),
              );
              uploadedParts.push({ PartNumber: partNumber, ETag: part.ETag! });
              partNumber++;
              bufferLen = 0;
              buffer = new Uint8Array(PART_SIZE);
            }
          }
        }
      }

      // 空文件或最后不足 5MB 的部分
      if (bufferLen > 0 || uploadedParts.length === 0) {
        const partBody = bufferLen === buffer.length
          ? buffer
          : buffer.slice(0, bufferLen);
        const part = await this.client.send(
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: partBody,
          }),
        );
        uploadedParts.push({ PartNumber: partNumber, ETag: part.ETag! });
      }

      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: uploadedParts },
        }),
      );
    } catch (err) {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ).catch(() => {});
      throw err;
    }

    const hashHex = Array.from(hash.digest())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return buildStorageUrl("s3", key, hashHex);
  }

  /**
   * 根据 `noj-storage://s3/` URL 从 S3 读取数据
   */
  async get(url: string): Promise<Uint8Array> {
    const parsed = parseStorageUrl(url);
    if (parsed.provider !== "s3") {
      throw new Error(`s3 provider 拒绝 ${parsed.provider} URL`);
    }
    validateStorageKey(parsed.key);

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: parsed.key,
      }),
    );

    const body = response.Body;
    if (!body) {
      throw new Error(`S3 object is empty: ${parsed.key}`);
    }

    // 将 ReadableStream 转换为 Uint8Array
    return body.transformToByteArray();
  }

  /**
   * 根据 `noj-storage://s3/` URL 从 S3 删除数据
   *
   * 幂等操作：对象不存在时静默忽略
   */
  async delete(url: string): Promise<void> {
    const parsed = parseStorageUrl(url);
    if (parsed.provider !== "s3") {
      throw new Error(`s3 provider 拒绝 ${parsed.provider} URL`);
    }
    validateStorageKey(parsed.key);

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: parsed.key,
        }),
      );
    } catch (err) {
      // S3 DeleteObject 是幂等的，但某些实现可能返回 NoSuchKey
      const errMsg = String(err);
      if (errMsg.includes("NoSuchKey") || errMsg.includes("NotFound")) {
        return;
      }
      throw err;
    }
  }

  /**
   * 将 `noj-storage://s3/` URL 转换为 `noj-download://s3` URL
   *
   * 生成 presigned GET URL（默认 1 小时过期），
   * 百分号编码后嵌入 `noj-download://s3?url=...`
   */
  async downloadUrl(storageUrl: string, expiresIn = 3600): Promise<string> {
    const parsed = parseStorageUrl(storageUrl);
    if (parsed.provider !== "s3") {
      throw new Error(`s3 provider 拒绝 ${parsed.provider} URL`);
    }
    validateStorageKey(parsed.key);

    const presignedUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: parsed.key,
      }),
      { expiresIn },
    );

    return buildS3DownloadUrl(presignedUrl, parsed.checksumSha256);
  }

  /**
   * 确保 S3 bucket 存在
   *
   * 非致命——创建失败仅 warn，不阻止启动
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
      );
    } catch (err) {
      const errMsg = String(err);
      // Bucket 不存在（404/NoSuchBucket）时尝试创建
      if (
        errMsg.includes("NotFound") ||
        errMsg.includes("NoSuchBucket") ||
        errMsg.includes("404")
      ) {
        try {
          await this.client.send(
            new CreateBucketCommand({ Bucket: this.bucket }),
          );
          logger.info("已创建 S3 bucket", { bucket: this.bucket });
        } catch (createErr) {
          logger.warn("创建 S3 bucket 失败", {
            bucket: this.bucket,
            err: createErr,
          });
        }
      } else {
        logger.warn("head S3 bucket 失败", {
          bucket: this.bucket,
          error: errMsg,
        });
      }
    }
  }
}
