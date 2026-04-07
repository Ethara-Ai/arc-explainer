

import { logger } from '../utils/logger.ts';

export const CLOUD_MODELS = {
  'cloud-claude-opus-4.6': {
    modelId: process.env.CLAUDE_CLOUD_MODEL_ID ?? '',
    displayName: 'Claude Opus 4.6',
    provider: 'cloud',
  },
  'cloud-kimi-k2.5': {
    modelId: process.env.KIMI_CLOUD_MODEL_ID ?? '',
    displayName: 'Kimi K2.5',
    provider: 'cloud',
  },
} as const;

class CloudModelService {
  private initialized = false;

  async initialize(): Promise<boolean> {
    const accessKeyId = process.env.CLOUD_ACCESS_KEY_ID;
    const secretAccessKey = process.env.CLOUD_SECRET_ACCESS_KEY;
    const region = process.env.CLOUD_REGION || 'us-east-1';

    if (!accessKeyId || !secretAccessKey) {
      logger.warn('Cloud credentials not configured -- cloud model service unavailable', 'cloud');
      return false;
    }

    logger.info(`Cloud model service initialized (region: ${region})`, 'cloud');
    this.initialized = true;
    return true;
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  getModels() {
    return CLOUD_MODELS;
  }
}

export const cloudModelService = new CloudModelService();
