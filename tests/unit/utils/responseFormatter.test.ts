import { describe, it, expect } from 'vitest';
import { formatResponse } from '../../../server/utils/responseFormatter';

describe('formatResponse', () => {
  describe('success', () => {
    it('returns success envelope with data', () => {
      const result = formatResponse.success({ id: 1 });
      expect(result).toEqual({ success: true, data: { id: 1 } });
    });

    it('includes message when provided', () => {
      const result = formatResponse.success({ id: 1 }, 'Created');
      expect(result).toEqual({ success: true, data: { id: 1 }, message: 'Created' });
    });

    it('omits message when falsy', () => {
      const result = formatResponse.success({ id: 1 }, '');
      expect(result).not.toHaveProperty('message');
    });

    it('handles null data', () => {
      const result = formatResponse.success(null);
      expect(result).toEqual({ success: true, data: null });
    });

    it('handles undefined data', () => {
      const result = formatResponse.success(undefined);
      expect(result).toEqual({ success: true, data: undefined });
    });

    it('handles array data', () => {
      const result = formatResponse.success([1, 2, 3]);
      expect(result.data).toEqual([1, 2, 3]);
    });
  });

  describe('error', () => {
    it('returns error envelope', () => {
      const result = formatResponse.error('NOT_FOUND', 'Resource not found');
      expect(result).toEqual({
        success: false,
        error: 'NOT_FOUND',
        message: 'Resource not found',
      });
    });

    it('includes details when provided', () => {
      const result = formatResponse.error('VALIDATION', 'Invalid input', { field: 'name' });
      expect(result).toEqual({
        success: false,
        error: 'VALIDATION',
        message: 'Invalid input',
        details: { field: 'name' },
      });
    });

    it('omits details when falsy', () => {
      const result = formatResponse.error('ERR', 'msg', null);
      expect(result).not.toHaveProperty('details');
    });

    it('omits details when undefined', () => {
      const result = formatResponse.error('ERR', 'msg', undefined);
      expect(result).not.toHaveProperty('details');
    });

    it('includes details when 0', () => {
      const result = formatResponse.error('ERR', 'msg', 0);
      // 0 is falsy, so details should be omitted
      expect(result).not.toHaveProperty('details');
    });
  });
});
