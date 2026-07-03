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
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@^3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@^3";

import {
  buildS3DownloadUrl,
  buildStorageUrl,
  parseStorageUrl,
  sha256Hex,
  type StorageProvider,
} from "./types.ts";

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

  constructor(config: S3StorageConfig) {
    this.client = new S3Client({
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
   * 根据 `noj-storage://s3/` URL 从 S3 读取数据
   */
  async get(url: string): Promise<Uint8Array> {
    const parsed = parseStorageUrl(url);

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
    return await body.transformToByteArray();
  }

  /**
   * 根据 `noj-storage://s3/` URL 从 S3 删除数据
   *
   * 幂等操作：对象不存在时静默忽略
   */
  async delete(url: string): Promise<void> {
    const parsed = parseStorageUrl(url);
    if (!parsed.key) return;

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
          console.log(
            `[storage/s3] Created bucket: ${this.bucket}`,
          );
        } catch (createErr) {
          console.warn(
            `[storage/s3] ⚠️  Failed to create bucket "${this.bucket}": ${createErr}`,
          );
        }
      } else {
        console.warn(
          `[storage/s3] ⚠️  Failed to head bucket "${this.bucket}": ${errMsg}`,
        );
      }
    }
  }
}
