/**
 * SecretStore 抽象：为未来接入 Vault/KMS/TPM 预留。
 * 当前默认实现从环境变量读取主密钥。
 */
export interface SecretStore {
  /** 获取信封加密主密钥（用于加密/解密上游 Provider API Key） */
  getStoreKey(): Promise<Uint8Array>;
  /** 获取服务间鉴权密钥 / AEAD eval_token 密钥 */
  getServiceToken(): Promise<string>;
}

export class EnvSecretStore implements SecretStore {
  constructor(
    private readonly storeKey: string,
    private readonly serviceToken: string,
  ) {}

  async getStoreKey(): Promise<Uint8Array> {
    return new TextEncoder().encode(this.storeKey);
  }

  async getServiceToken(): Promise<string> {
    return this.serviceToken;
  }
}
