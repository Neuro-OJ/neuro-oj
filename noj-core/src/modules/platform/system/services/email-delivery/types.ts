/** 内部统一的邮件送达事件类型；不等同于任一厂商的 webhook 字段。 */
export type EmailDeliveryEventType =
  | "delivery"
  | "temporary_failure"
  | "permanent_bounce"
  | "complaint";

export interface EmailDeliveryEvent {
  provider: string;
  providerEventId: string;
  type: EmailDeliveryEventType;
  email: string;
  occurredAt: string;
  reasonCode?: string;
  reason?: string;
}

export interface NormalizedEmailDeliveryEvent
  extends Omit<EmailDeliveryEvent, "email"> {
  recipientHash: string;
  recipientMasked: string;
}

/** 厂商适配器契约；解析前必须完成签名、时间戳和重放校验。 */
export interface EmailDeliveryAdapter {
  readonly provider: string;
  parse(request: Request, secret: string): Promise<EmailDeliveryEvent>;
}

export class EmailDeliveryAdapterError extends Error {
  constructor(message: string, readonly code = "EMAIL_EVENT_INVALID") {
    super(message);
    this.name = "EmailDeliveryAdapterError";
  }
}
