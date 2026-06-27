import axios, { AxiosInstance } from 'axios';
import { buildAmzRequest, decryptAmzItem } from '../utils/amzCrypto';
import { config } from '../config';

export interface CreateCardRequest {
  bin: string;
  card_type: 'VISA' | 'MASTERCARD';
  amount: number;
  currency?: string;
  remark?: string;
}

export interface CreateCardResponse {
  code: number;
  msg: string;
  data?: {
    task_id: string;
    order_no: string;
  };
}

export interface TaskDetailResponse {
  code: number;
  msg: string;
  data?: {
    task_id: string;
    order_no: string;
    status: number;
    item?: string;
    fail_reason?: string;
  };
}

export interface DecryptedCardInfo {
  card_no: string;
  cvv: string;
  valid_date: string;
  card_type: string;
}

export interface AuthCodeRequest {
  card_no: string;
  cvv: string;
  valid_date: string;
}

export interface AuthCodeResponse {
  code: number;
  msg: string;
  data?: {
    auth_code: string;
    expire_time: string;
  };
}

export interface AuthCodeItem {
  id: string;
  card_no_last4: string;
  auth_code: string;
  merchant_name: string;
  trader_amount: string;
  trader_billing_currency_code: string;
  content: string;
  create_time: string;
}

export interface AuthCodePoolResponse {
  code: number;
  msg: string;
  data?: {
    items: AuthCodeItem[];
    total: number;
  };
}

export class AmzKeysClient {
  private http: AxiosInstance;
  private cfg: AmzKeysConfig;

  constructor(cfg: AmzKeysConfig) {
    this.cfg = cfg;
    this.http = axios.create({
      baseURL: cfg.baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async createCard(req: CreateCardRequest): Promise<CreateCardResponse> {
    const params = buildAmzRequest(this.cfg.appId, this.cfg.appKey, this.cfg.privateKey, req);
    const { data } = await this.http.post('/api/v1/card/create', params);
    return data;
  }

  async getTaskDetail(taskId: string): Promise<TaskDetailResponse> {
    const params = buildAmzRequest(this.cfg.appId, this.cfg.appKey, this.cfg.privateKey, { task_id: taskId });
    const { data } = await this.http.post('/api/v1/card/taskDetail', params);
    return data;
  }

  async pollTaskUntilComplete(
    taskId: string,
    options: { intervalMs?: number; maxAttempts?: number } = {}
  ): Promise<DecryptedCardInfo> {
    const intervalMs = options.intervalMs ?? 10000;
    const maxAttempts = options.maxAttempts ?? 60;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const resp = await this.getTaskDetail(taskId);
      if (resp.code !== 0) throw new Error(`AmzKeys taskDetail error: ${resp.msg}`);
      const taskData = resp.data!;
      if (taskData.status === 2) {
        if (!taskData.item) throw new Error('Task success but item is empty');
        const decrypted = decryptAmzItem(taskData.item, this.cfg.aesKey);
        return JSON.parse(decrypted) as DecryptedCardInfo;
      }
      if (taskData.status === 3) {
        throw new Error(`AmzKeys card creation failed: ${taskData.fail_reason || 'Unknown'}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Polling timeout for task ${taskId}`);
  }

  async getAuthCode(req: AuthCodeRequest): Promise<AuthCodeResponse> {
    const params = buildAmzRequest(this.cfg.appId, this.cfg.appKey, this.cfg.privateKey, req);
    const { data } = await this.http.post('/api/v1/authorization/authCode', params);
    return data;
  }

  async getAuthCodePool(): Promise<AuthCodePoolResponse> {
    const params = buildAmzRequest(this.cfg.appId, this.cfg.appKey, this.cfg.privateKey, {});
    const { data } = await this.http.post('/api/v1/authorization/authCode', params);
    return data;
  }
}

interface AmzKeysConfig {
  baseUrl: string;
  appId: string;
  appKey: string;
  privateKey: string;
  aesKey: string;
}

let amzClient: AmzKeysClient | null = null;

export function getAmzClient(): AmzKeysClient | null {
  if (amzClient) return amzClient;
  if (!config.amzKeys.appId || !config.amzKeys.privateKey || !config.amzKeys.aesKey) {
    return null;
  }
  amzClient = new AmzKeysClient(config.amzKeys);
  return amzClient;
}
