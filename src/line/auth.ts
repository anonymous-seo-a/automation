import { config } from '../config';

export function isAuthorizedUser(userId: string): boolean {
  return userId === config.line.allowedUserId;
}
