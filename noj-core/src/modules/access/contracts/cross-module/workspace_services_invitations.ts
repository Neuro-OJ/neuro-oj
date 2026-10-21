/** 跨模块窄能力合同；只列出生产调用方实际需要的符号。 */
export {
  createDomainInvitation,
  invitationListColumns,
  revokeDomainInvitation,
} from "../../workspace/services/invitations.ts";
export type { DomainInvitationInput } from "../../workspace/services/invitations.ts";
