import crypto from 'crypto';

export function rsa2Sign(content: string, privateKeyPem: string): string {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(content, 'utf8');
  return sign.sign(privateKeyPem, 'base64');
}

export function aes128CfbDecrypt(encryptedHex: string, key: string): string {
  const keyBuf = Buffer.from(key, 'utf8');
  const iv = keyBuf.slice(0, 16);
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-128-cfb', keyBuf, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export function buildAmzRequest(
  appId: string,
  appKey: string,
  privateKey: string,
  body: Record<string, any>
): { appId: string; appKey: string; requestBody: string; sign: string } {
  const requestBody = JSON.stringify(body).replace(/\s+/g, '');
  const signStr = `${appId}${appKey}${requestBody}`;
  const sign = rsa2Sign(signStr, privateKey);
  return { appId, appKey, requestBody, sign };
}

export function decryptAmzItem(encryptedItem: string, aesKey: string): string {
  return aes128CfbDecrypt(encryptedItem, aesKey);
}
