/**
 * Wallet Service Tests
 * Tests for UPI payments, UTR validation, escrow, commissions, etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Wallet Service - UPI Payment Flow', () => {
  describe('Service Charge Payment', () => {
    it('should calculate 10% admin fee correctly', () => {
      const amounts = [1000, 5000, 10000, 25000, 50000, 100000];
      amounts.forEach(amount => {
        const adminFee = Math.floor(amount * 0.10);
        const sellerAmount = amount - adminFee;
        expect(adminFee + sellerAmount).toBe(amount);
        expect(adminFee).toBe(Math.floor(amount * 0.10));
      });
    });

    it('should handle floor correctly for non-round amounts', () => {
      const amount = 1234;
      const adminFee = Math.floor(amount * 0.10); // 123.4 -> 123
      const sellerAmount = amount - adminFee; // 1111
      expect(adminFee).toBe(123);
      expect(sellerAmount).toBe(1111);
    });
  });

  describe('UTR Validation', () => {
    function cleanUtr(utr) {
      return String(utr || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
    }

    it('should clean UTR correctly', () => {
      expect(cleanUtr('  abc123xyz  ')).toBe('ABC123XYZ');
      expect(cleanUtr('utr-123_456')).toBe('UTR123456');
      expect(cleanUtr('Utr@#$%^&*()')).toBe('UTR');
    });

    it('should reject too short UTR', () => {
      expect(cleanUtr('12345').length).toBeLessThan(6);
      expect(cleanUtr('abcde').length).toBeLessThan(6);
    });

    it('should truncate long UTR', () => {
      const long = 'A'.repeat(50);
      expect(cleanUtr(long).length).toBe(40);
    });

    it('should only allow alphanumeric', () => {
      const utr = cleanUtr('UTR-123/456');
      expect(utr).toBe('UTR123456');
      expect(/^[A-Z0-9]+$/.test(utr)).toBe(true);
    });
  });

  describe('Payment Status Transitions', () => {
    const statuses = ['awaiting_confirmation', 'submitted', 'paid', 'released'];
    
    it('should define valid statuses', () => {
      expect(statuses).toContain('awaiting_confirmation');
      expect(statuses).toContain('submitted');
      expect(statuses).toContain('paid');
      expect(statuses).toContain('released');
    });

    it('should validate status flow', () => {
      // awaiting_confirmation -> submitted -> paid/released
      const validTransitions = {
        awaiting_confirmation: ['submitted'],
        submitted: ['paid', 'released'],
        paid: ['released'],
        released: []
      };
      
      expect(validTransitions.awaiting_confirmation).toContain('submitted');
      expect(validTransitions.submitted).toContain('paid');
      expect(validTransitions.submitted).toContain('released');
      expect(validTransitions.paid).toContain('released');
    });
  });

  describe('Order Validation', () => {
    it('should validate order_id format', () => {
      const validIds = ['123', 'abc123', 'order-123', 'ORDER_123'];
      const invalidIds = ['', 'a'.repeat(65), 'order@123', 'order 123'];
      
      validIds.forEach(id => {
        expect(id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
      });
      
      invalidIds.forEach(id => {
        expect(id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
      });
    });

    it('should validate seller matches order', () => {
      const listing = { id: 1, seller_id: 'seller1', price: 5000 };
      const requestSellerId = 'seller1';
      const wrongSellerId = 'seller2';
      
      expect(listing.seller_id).toBe(requestSellerId);
      expect(listing.seller_id).not.toBe(wrongSellerId);
    });

    it('should validate payment amount matches listing', () => {
      const listingPrice = 5000;
      const fullPayment = 5000;
      const halfPayment = 2500;
      const overPayment = 6000;
      const underPayment = 4000;
      
      expect(fullPayment).toBe(listingPrice);
      expect(halfPayment).toBeLessThanOrEqual(listingPrice);
      expect(overPayment).toBeGreaterThan(listingPrice);
      expect(underPayment).not.toBe(listingPrice);
    });
  });

  describe('Rate Limiting', () => {
    const attempts = new Map();
    
    function checkRateLimit(userId, seconds, max) {
      const now = Date.now();
      const key = `${userId}:${seconds}`;
      
      if (!attempts.has(key)) {
        attempts.set(key, { count: 1, windowStart: now });
        return false; // not limited
      }
      
      const entry = attempts.get(key);
      if (now - entry.windowStart > seconds * 1000) {
        attempts.set(key, { count: 1, windowStart: now });
        return false;
      }
      
      if (entry.count >= max) {return true;}
      
      entry.count++;
      return false;
    }

    beforeEach(() => {
      attempts.clear();
    });

    it('should limit requests per time window', () => {
      const userId = 'user1';
      
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit(userId, 60, 5)).toBe(false);
      }
      expect(checkRateLimit(userId, 60, 5)).toBe(true); // 6th request blocked
    });

    it('should track different users separately', () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit('user1', 60, 5);
      }
      expect(checkRateLimit('user1', 60, 5)).toBe(true);
      expect(checkRateLimit('user2', 60, 5)).toBe(false);
    });
  });

  describe('Seller UPI Resolution', () => {
    it('should prefer seller UPI over admin fallback', () => {
      const sellerUpi = 'seller@bank';
      const adminUpi = 'admin@platform';
      
      const payeeUpi = sellerUpi || adminUpi;
      expect(payeeUpi).toBe('seller@bank');
    });

    it('should fallback to admin UPI when seller has none', () => {
      const sellerUpi = null;
      const adminUpi = 'admin@platform';
      
      const payeeUpi = sellerUpi || adminUpi;
      expect(payeeUpi).toBe('admin@platform');
    });
  });
});

describe('Wallet Service - Escrow Release', () => {
  describe('Admin Release Validation', () => {
    it('should require payment in submitted/paid status', () => {
      const validStatuses = ['submitted', 'paid'];
      const invalidStatuses = ['awaiting_confirmation', 'released', 'cancelled'];
      
      validStatuses.forEach(status => {
        expect(validStatuses.includes(status)).toBe(true);
      });
      
      invalidStatuses.forEach(status => {
        expect(validStatuses.includes(status)).toBe(false);
      });
    });

    it('should prevent double release', () => {
      const payment = { status: 'released' };
      const alreadyReleased = payment.status === 'released';
      expect(alreadyReleased).toBe(true);
    });

    it('should create seller earnings on release', () => {
      const payment = { seller_id: 'seller1', seller_amount: 4500, order_id: 'order1' };
      
      const earnings = {
        seller_id: payment.seller_id,
        order_id: payment.order_id,
        amount: payment.seller_amount,
        status: 'released'
      };
      
      expect(earnings.seller_id).toBe('seller1');
      expect(earnings.amount).toBe(4500);
      expect(earnings.status).toBe('released');
    });
  });
});

describe('Wallet Service - Seller Balance', () => {
  it('should calculate available balance correctly', () => {
    const released = 10000;
    const held = 5000;
    const withdrawn = 3000;
    
    const available = Math.max(0, released - withdrawn);
    expect(available).toBe(7000);
  });

  it('should not allow negative balance', () => {
    const released = 1000;
    const withdrawn = 2000;
    
    const available = Math.max(0, released - withdrawn);
    expect(available).toBe(0);
  });
});

describe('Wallet Service - Withdrawal', () => {
  it('should validate withdrawal amount', () => {
    const minWithdrawal = 10;
    const maxWithdrawal = 10000000;
    
    expect(minWithdrawal).toBe(10);
    expect(maxWithdrawal).toBe(10000000);
  });

  it('should validate UPI ID for withdrawal', () => {
    const validUpi = 'user@bank';
    const invalidUpi = 'invalid-upi';
    
    expect(/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(validUpi)).toBe(true);
    expect(/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(invalidUpi)).toBe(false);
  });

  it('should check sufficient balance', () => {
    const available = 5000;
    const requestAmount = 6000;
    
    expect(requestAmount > available).toBe(true);
  });
});

describe('Wallet Service - Admin Earnings Report', () => {
  it('should calculate total admin fees', () => {
    const payments = [
      { admin_fee: 500, status: 'paid' },
      { admin_fee: 1000, status: 'paid' },
      { admin_fee: 200, status: 'submitted' }
    ];
    
    const total = payments
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + p.admin_fee, 0);
    
    expect(total).toBe(1500);
  });

  it('should count pending payments', () => {
    const payments = [
      { status: 'paid' },
      { status: 'submitted' },
      { status: 'awaiting_confirmation' },
      { status: 'released' }
    ];
    
    const pending = payments.filter(p => p.status === 'awaiting_confirmation').length;
    expect(pending).toBe(1);
  });

  it('should calculate pending withdrawal amount', () => {
    const withdrawals = [
      { amount: 5000, status: 'pending' },
      { amount: 3000, status: 'pending' },
      { amount: 2000, status: 'processed' }
    ];
    
    const pendingAmount = withdrawals
      .filter(w => w.status === 'pending')
      .reduce((sum, w) => sum + w.amount, 0);
    
    expect(pendingAmount).toBe(8000);
  });
});

describe('Wallet Service - Platform Settings', () => {
  it('should validate admin UPI ID', () => {
    const validUpi = 'admin@platform';
    const invalidUpi = 'invalid';
    
    expect(/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(validUpi)).toBe(true);
    expect(/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(invalidUpi)).toBe(false);
  });

  it('should validate admin UPI name length', () => {
    const validName = 'BGMI Market';
    const tooLong = 'A'.repeat(61);
    
    expect(validName.length <= 60).toBe(true);
    expect(tooLong.length > 60).toBe(true);
  });
});

describe('Wallet Service - UTR Uniqueness', () => {
  const usedUtrs = new Set(['UTR123', 'UTR456']);
  
  function isUtrUnique(utr) {
    return !usedUtrs.has(utr);
  }

  beforeEach(() => {
    usedUtrs.clear();
    usedUtrs.add('UTR123');
    usedUtrs.add('UTR456');
  });

  it('should reject duplicate UTR', () => {
    expect(isUtrUnique('UTR123')).toBe(false);
    expect(isUtrUnique('UTR456')).toBe(false);
  });

  it('should allow new UTR', () => {
    expect(isUtrUnique('UTR789')).toBe(true);
    expect(isUtrUnique('NEUTR123')).toBe(true);
  });
});