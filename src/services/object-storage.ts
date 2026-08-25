import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

export interface VaultObjectStorage {
  readonly backend: "s3";
  put(key: string, bytes: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Uint8Array>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

function normalizePrefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/gu, "");
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("VAULT_OBJECT_PREFIX tidak valid.");
  }
  return `${prefix}/`;
}

export class S3VaultObjectStorage implements VaultObjectStorage {
  readonly backend = "s3" as const;
  readonly prefix: string;
  private readonly client: S3Client;

  constructor(private readonly config: AppConfig) {
    if (
      !config.S3_BUCKET ||
      !config.S3_ENDPOINT ||
      !config.S3_ACCESS_KEY_ID ||
      !config.S3_SECRET_ACCESS_KEY
    ) {
      throw new Error("Kredensial S3 vault belum lengkap.");
    }
    this.prefix = normalizePrefix(config.VAULT_OBJECT_PREFIX);
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET!,
        Key: this.objectKey(key),
        Body: bytes,
        ContentType: contentType,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
  }

  async get(key: string, signal?: AbortSignal): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET!, Key: this.objectKey(key) }),
      signal ? { abortSignal: signal } : undefined,
    );
    if (!result.Body) throw new Error("Byte object S3 tidak tersedia.");
    return result.Body.transformToByteArray();
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET!, Key: this.objectKey(key) }),
      signal ? { abortSignal: signal } : undefined,
    );
  }

  private objectKey(key: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(key)) throw new Error("Storage key S3 tidak valid.");
    return `${this.prefix}${key}`;
  }
}

export function createVaultObjectStorage(config: AppConfig): VaultObjectStorage | null {
  const credentialsAvailable = Boolean(
    config.S3_BUCKET &&
      config.S3_ENDPOINT &&
      config.S3_ACCESS_KEY_ID &&
      config.S3_SECRET_ACCESS_KEY,
  );
  return credentialsAvailable ? new S3VaultObjectStorage(config) : null;
}
