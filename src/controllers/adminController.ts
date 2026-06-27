import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
import { AuthRequest } from '../middleware/auth'
import { getAmzClient } from '../services/amzKeysService'
import { pollAndActivateAmzCard } from '../services/cardActivationService'

export const adminController = {
  getState: async (req: AuthRequest, res: Response) => {
    try {
      const [users, cards, transactions, bins, config, kyc, recon] = await Promise.all([
        prisma.user.count(),
        prisma.card.count(),
        prisma.transaction.count(),
        prisma.binConfig.findMany({ orderBy: { bin: 'asc' } }),
        prisma.adminConfig.findFirst(),
        prisma.kycRecord.count({ where: { status: 'pending' } }),
        prisma.reconciliationRequest.count({ where: { status: 'pending_review' } })
      ])

      res.json({
        success: true,
        stats: { users, cards, transactions, pendingKYC: kyc, pendingReconciliation: recon },
        bins,
        config
      })
    } catch (err) {
      console.error('Admin getState error:', err)
      res.status(500).json({ error: '获取状态失败' })
    }
  },

  getConfig: async (req: AuthRequest, res: Response) => {
    try {
      let config = await prisma.adminConfig.findFirst()
      if (!config) {
        config = await prisma.adminConfig.create({
          data: {
            fundingAddress: '',
            depositFeeRate: 0.04,
            cardCreationFeesByVip: { '1': 44, '2': 39.6, '3': 33, '4': 26.4 },
            loadFeeRatesByVip: { '1': 0.04, '2': 0.035, '3': 0.028, '4': 0.02 },
            rebateRatesByVip: { '1': 0, '2': 0.005, '3': 0.012, '4': 0.02 }
          }
        })
      }
      res.json({ success: true, config })
    } catch (err) {
      res.status(500).json({ error: '获取配置失败' })
    }
  },

  updateConfig: async (req: AuthRequest, res: Response) => {
    try {
      const { fundingAddress, depositFeeRate, cardCreationFeesByVip, loadFeeRatesByVip, rebateRatesByVip } = req.body
      const existing = await prisma.adminConfig.findFirst()
      const config = await prisma.adminConfig.upsert({
        where: { id: existing?.id || '' },
        create: {
          fundingAddress: fundingAddress || '',
          depositFeeRate: depositFeeRate ?? 0.04,
          cardCreationFeesByVip: cardCreationFeesByVip || { '1': 44, '2': 39.6, '3': 33, '4': 26.4 },
          loadFeeRatesByVip: loadFeeRatesByVip || { '1': 0.04, '2': 0.035, '3': 0.028, '4': 0.02 },
          rebateRatesByVip: rebateRatesByVip || { '1': 0, '2': 0.005, '3': 0.012, '4': 0.02 }
        },
        update: {
          fundingAddress: fundingAddress ?? undefined,
          depositFeeRate: depositFeeRate ?? undefined,
          cardCreationFeesByVip: cardCreationFeesByVip ?? undefined,
          loadFeeRatesByVip: loadFeeRatesByVip ?? undefined,
          rebateRatesByVip: rebateRatesByVip ?? undefined
        }
      })
      res.json({ success: true, config })
    } catch (err) {
      console.error('Update config error:', err)
      res.status(500).json({ error: '更新配置失败' })
    }
  },

  getBins: async (req: AuthRequest, res: Response) => {
    try {
      const bins = await prisma.binConfig.findMany({ orderBy: { bin: 'asc' } })
      res.json({ success: true, bins })
    } catch (err) {
      res.status(500).json({ error: '获取 BIN 列表失败' })
    }
  },

  createBin: async (req: AuthRequest, res: Response) => {
    try {
      const { bin, name, category, quality, network, status, routingType } = req.body
      if (!/^\d{6}$/.test(bin)) return res.status(400).json({ error: 'BIN 必须是 6 位数字' })
      if (!['Visa', 'Mastercard'].includes(network)) return res.status(400).json({ error: '网络类型无效' })

      const existing = await prisma.binConfig.findUnique({ where: { bin } })
      if (existing) return res.status(409).json({ error: 'BIN 已存在' })

      const newBin = await prisma.binConfig.create({
        data: { bin, name, category, quality, network, status: status || 'active', routingType }
      })
      res.status(201).json({ success: true, bin: newBin })
    } catch (err) {
      console.error('Create bin error:', err)
      res.status(500).json({ error: '创建 BIN 失败' })
    }
  },

  updateBin: async (req: AuthRequest, res: Response) => {
    try {
      const { bin } = req.params
      const { name, category, quality, network, status, routingType } = req.body
      const updated = await prisma.binConfig.update({
        where: { bin },
        data: { name, category, quality, network, status, routingType }
      })
      res.json({ success: true, bin: updated })
    } catch (err) {
      res.status(500).json({ error: '更新 BIN 失败' })
    }
  },

  deleteBin: async (req: AuthRequest, res: Response) => {
    try {
      await prisma.binConfig.delete({ where: { bin: req.params.bin } })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: '删除 BIN 失败' })
    }
  },

  toggleBinStatus: async (req: AuthRequest, res: Response) => {
    try {
      const { bin } = req.params
      const { status } = req.body
      if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: '状态无效' })
      }
      const updated = await prisma.binConfig.update({
        where: { bin },
        data: { status }
      })
      res.json({ success: true, bin: updated })
    } catch (err) {
      res.status(500).json({ error: '更新状态失败' })
    }
  },

  createTransaction: async (req: AuthRequest, res: Response) => {
    try {
      const { cardId, merchant, amount, currency, status, timestamp, description, cardLast4, cardNickname } = req.body
      if (!merchant || !amount || !currency) {
        return res.status(400).json({ error: '缺少必填字段' })
      }

      let userId = req.user!.id
      if (cardId) {
        const card = await prisma.card.findUnique({ where: { id: cardId } })
        if (card) userId = card.userId
      }

      const tx = await prisma.transaction.create({
        data: {
          userId,
          cardId,
          cardLast4,
          cardNickname,
          merchant,
          amount: parseFloat(amount),
          currency,
          status: status || 'success',
          timestamp: timestamp ? new Date(timestamp) : new Date(),
          description: description || 'Manual ledger entry'
        }
      })

      if (cardId && tx.status === 'success') {
        await prisma.card.update({
          where: { id: cardId },
          data: { balance: { increment: tx.amount } }
        })
      }

      res.json({ success: true, transaction: tx })
    } catch (err) {
      console.error('Create transaction error:', err)
      res.status(500).json({ error: '创建交易失败' })
    }
  },

  batchTransactions: async (req: AuthRequest, res: Response) => {
    try {
      const { transactions } = req.body
      if (!Array.isArray(transactions)) return res.status(400).json({ error: 'transactions 必须是数组' })

      const results = await Promise.all(transactions.map(async (t: any) => {
        let userId = req.user!.id
        if (t.cardId) {
          const card = await prisma.card.findUnique({ where: { id: t.cardId } })
          if (card) userId = card.userId
        }

        const tx = await prisma.transaction.create({
          data: {
            userId,
            cardId: t.cardId || null,
            cardLast4: t.cardLast4,
            cardNickname: t.cardNickname,
            merchant: t.merchant,
            amount: parseFloat(t.amount),
            currency: t.currency || 'USD',
            status: t.status || 'success',
            timestamp: t.timestamp ? new Date(t.timestamp) : new Date(),
            description: t.description || 'Batch ledger import'
          }
        })
        if (tx.cardId && tx.status === 'success') {
          await prisma.card.update({
            where: { id: tx.cardId },
            data: { balance: { increment: tx.amount } }
          })
        }
        return tx
      }))

      res.json({ success: true, count: results.length, transactions: results })
    } catch (err) {
      console.error('Batch transactions error:', err)
      res.status(500).json({ error: '批量导入失败' })
    }
  },

  activateCard: async (req: AuthRequest, res: Response) => {
    try {
      const { number, cvv, expiry, billingAddress } = req.body
      const card = await prisma.card.findFirst({
        where: { id: req.params.id, status: 'pending' }
      })
      if (!card) return res.status(404).json({ error: '申请单不存在' })

      if (!/^\d{13,19}$/.test(number.replace(/\s/g, ''))) return res.status(400).json({ error: '无效卡号' })
      if (!/^\d{3,4}$/.test(cvv)) return res.status(400).json({ error: '无效 CVV' })
      if (!/^\d{2}\/\d{2}$/.test(expiry)) return res.status(400).json({ error: '无效有效期 (MM/YY)' })

      const activated = await prisma.card.update({
        where: { id: card.id },
        data: {
          number,
          cvv,
          expiry,
          balance: card.limit,
          status: 'active',
          billingAddress: billingAddress || '',
          issuedAt: new Date(),
          routingType: null,
          amzTaskId: null,
          amzOrderNo: null
        }
      })

      await prisma.transaction.updateMany({
        where: { description: { contains: card.id } },
        data: { status: 'success' }
      })

      res.json({ success: true, card: activated })
    } catch (err) {
      console.error('Activate card error:', err)
      res.status(500).json({ error: '激活失败' })
    }
  },

  // Admin card actions - real operations
  adminCardAction: async (req: AuthRequest, res: Response) => {
    try {
      const { cardId } = req.params
      const { action, ...data } = req.body

      const card = await prisma.card.findUnique({ where: { id: cardId } })
      if (!card) return res.status(404).json({ error: '卡片不存在' })

      switch (action) {
        case 'freeze': {
          if (card.status !== 'active') return res.status(400).json({ error: '仅激活卡可冻结' })
          await prisma.card.update({ where: { id: cardId }, data: { status: 'frozen' } })
          break
        }
        case 'unfreeze': {
          if (card.status !== 'frozen') return res.status(400).json({ error: '仅冻结卡可解冻' })
          await prisma.card.update({ where: { id: cardId }, data: { status: 'active' } })
          break
        }
        case 'cancel': {
          if (!['pending', 'active', 'frozen'].includes(card.status)) return res.status(400).json({ error: '该状态不可注销' })
          if (card.status === 'active' && card.balance > 0) {
            await prisma.user.update({ where: { id: card.userId }, data: { walletBalance: { increment: card.balance } } })
            await prisma.transaction.create({
              data: { userId: card.userId, cardId: card.id, cardLast4: card.number.slice(-4), cardNickname: card.nickname, merchant: 'Admin Card Cancel Refund', amount: card.balance, currency: 'USD', status: 'success', description: `Admin cancelled ${card.nickname}, balance refunded` }
            })
          }
          await prisma.card.update({ where: { id: cardId }, data: { status: 'cancelled' } })
          break
        }
        case 'adjust_limit': {
          const { newLimit } = data
          const numLimit = parseFloat(newLimit)
          if (isNaN(numLimit) || numLimit < 10) return res.status(400).json({ error: '最低额度 $10' })
          if (numLimit < card.balance) return res.status(400).json({ error: '额度不能低于当前余额' })
          await prisma.card.update({ where: { id: cardId }, data: { limit: numLimit } })
          break
        }
        case 'topup': {
          const { amount } = data
          const numAmount = parseFloat(amount)
          if (isNaN(numAmount) || numAmount < 1) return res.status(400).json({ error: '充值金额无效' })
          await prisma.card.update({ where: { id: cardId }, data: { balance: { increment: numAmount } } })
          await prisma.transaction.create({
            data: { userId: card.userId, cardId: card.id, cardLast4: card.number.slice(-4), cardNickname: card.nickname, merchant: 'Admin Topup', amount: numAmount, currency: 'USD', status: 'success', description: `Admin topup to ${card.nickname}` }
          })
          break
        }
        case 'withdraw': {
          const { amount } = data
          const numAmount = parseFloat(amount)
          if (isNaN(numAmount) || numAmount < 1) return res.status(400).json({ error: '提现金额无效' })
          if (card.balance < numAmount) return res.status(400).json({ error: '卡片余额不足' })
          await prisma.card.update({ where: { id: cardId }, data: { balance: { decrement: numAmount } } })
          await prisma.user.update({ where: { id: card.userId }, data: { walletBalance: { increment: numAmount } } })
          await prisma.transaction.create({
            data: { userId: card.userId, cardId: card.id, cardLast4: card.number.slice(-4), cardNickname: card.nickname, merchant: 'Admin Withdrawal', amount: -numAmount, currency: 'USD', status: 'success', description: `Admin withdrawal from ${card.nickname}` }
          })
          break
        }
        case 'force_refund': {
          const { amount, reason } = data
          const numAmount = parseFloat(amount)
          if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: '退款金额无效' })
          await prisma.user.update({ where: { id: card.userId }, data: { walletBalance: { increment: numAmount } } })
          await prisma.transaction.create({
            data: { userId: card.userId, cardId: card.id, cardLast4: card.number.slice(-4), cardNickname: card.nickname, merchant: 'Admin Force Refund', amount: numAmount, currency: 'USD', status: 'success', description: reason || 'Admin force refund' }
          })
          break
        }
        default:
          return res.status(400).json({ error: '不支持的操作' })
      }

      const updated = await prisma.card.findUnique({ where: { id: cardId } })
      res.json({ success: true, card: updated })
    } catch (err) {
      console.error('Admin card action error:', err)
      res.status(500).json({ error: '操作失败' })
    }
  },

  getReconciliation: async (req: AuthRequest, res: Response) => {
    try {
      const requests = await prisma.reconciliationRequest.findMany({
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, email: true, name: true } } }
      })
      res.json({ success: true, requests })
    } catch (err) {
      res.status(500).json({ error: '获取对账列表失败' })
    }
  },

reviewReconciliation: async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params
      const { status, notes } = req.body

      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: '状态无效' })
      }

      const request = await prisma.reconciliationRequest.findUnique({ where: { id } })
      if (!request) return res.status(404).json({ error: '对账单不存在' })
      if (request.status !== 'pending_review') return res.status(400).json({ error: '已处理' })

      if (status === 'approved') {
        await prisma.user.update({
          where: { id: request.userId },
          data: { walletBalance: { increment: request.amount } }
        })
        await prisma.transaction.create({
          data: {
            userId: request.userId,
            cardId: null,
            merchant: 'Reconciliation Adjustment',
            amount: request.amount,
            currency: 'USD',
            status: 'success',
            description: `Reconciliation approved: ${request.reason} - ${notes || ''}`
          }
        })
      }

      await prisma.reconciliationRequest.update({
        where: { id },
        data: { status, reviewedAt: new Date(), reviewedBy: req.user!.id }
      })

      res.json({ success: true })
    } catch (err) {
      console.error('Review reconciliation error:', err)
      res.status(500).json({ error: '审核失败' })
    }
  },

  reviewKYC: async (req: AuthRequest, res: Response) => {
    try {
      const { userId } = req.params
      const { status, feedback } = req.body // 'approved' | 'rejected'

      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: '状态无效' })
      }

      const kyc = await prisma.kycRecord.findUnique({ where: { userId } })
      if (!kyc) return res.status(404).json({ error: 'KYC 记录不存在' })

      await prisma.kycRecord.update({
        where: { userId },
        data: { status, feedback, reviewedAt: new Date(), reviewedBy: req.user!.id }
      })

      res.json({ success: true })
    } catch (err) {
      console.error('Review KYC error:', err)
      res.status(500).json({ error: '审核失败' })
    }
  },

  getUsers: async (req: AuthRequest, res: Response) => {
    try {
      const { page = 1, limit = 20, search } = req.query
      const skip = (Number(page) - 1) * Number(limit)
      const where = search ? {
        OR: [
          { email: { contains: String(search) } },
          { name: { contains: String(search) } }
        ]
      } : {}

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: Number(limit),
          select: { id: true, email: true, name: true, avatar: true, walletBalance: true, vipLevel: true, identityClass: true, upstreamName: true, monthlySpend: true, twoFactorEnabled: true, createdAt: true }
        }),
        prisma.user.count({ where })
      ])

      res.json({ success: true, data: users, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) })
    } catch (err) {
      res.status(500).json({ error: '获取用户列表失败' })
    }
  },

  updateUser: async (req: AuthRequest, res: Response) => {
    try {
      const { userId } = req.params
      const { walletBalance, vipLevel, identityClass, upstreamName } = req.body

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          walletBalance: walletBalance !== undefined ? parseFloat(walletBalance) : undefined,
          vipLevel: vipLevel !== undefined ? parseInt(vipLevel) : undefined,
          identityClass,
          upstreamName
        }
      })

      res.json({ success: true, user })
    } catch (err) {
      res.status(500).json({ error: '更新用户失败' })
    }
  },

  getCards: async (req: AuthRequest, res: Response) => {
    try {
      const { page = 1, limit = 50, status, userId } = req.query
      const skip = (Number(page) - 1) * Number(limit)
      const where: any = {}
      if (status) where.status = status
      if (userId) where.userId = userId

      const [cards, total] = await Promise.all([
        prisma.card.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: Number(limit),
          include: { user: { select: { id: true, email: true, name: true } } }
        }),
        prisma.card.count({ where })
      ])

      res.json({ success: true, data: cards, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) })
    } catch (err) {
      res.status(500).json({ error: '获取卡片列表失败' })
    }
  },

  getTransactions: async (req: AuthRequest, res: Response) => {
    try {
      const { page = 1, limit = 100, status, userId, cardId } = req.query
      const skip = (Number(page) - 1) * Number(limit)
      const where: any = {}
      if (status) where.status = status
      if (userId) where.userId = userId
      if (cardId) where.cardId = cardId

      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          orderBy: { timestamp: 'desc' },
          skip,
          take: Number(limit),
          include: { user: { select: { id: true, email: true, name: true } }, card: { select: { id: true, nickname: true, number: true } } }
        }),
        prisma.transaction.count({ where })
      ])

      res.json({ success: true, data: transactions, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) })
    } catch (err) {
      res.status(500).json({ error: '获取交易列表失败' })
    }
  },

  // AmzKeys manual trigger for stuck cards
  retryAmzCard: async (req: AuthRequest, res: Response) => {
    try {
      const { cardId } = req.params
      const card = await prisma.card.findUnique({ where: { id: cardId } })
      if (!card) return res.status(404).json({ error: '卡片不存在' })
      if (!card.amzTaskId) return res.status(400).json({ error: '非 AmzKeys 卡片' })

      const client = getAmzClient()
      if (!client) return res.status(503).json({ error: 'AmzKeys 未配置' })

      pollAndActivateAmzCard(card.amzTaskId, card.id, card.limit, card.brand as 'Visa' | 'Mastercard')

      res.json({ success: true, message: '已重新触发轮询' })
    } catch (err) {
      console.error('Retry Amz card error:', err)
      res.status(500).json({ error: '重试失败' })
    }
  }
}
