import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
import { AuthRequest } from '../middleware/auth'
import { getAmzClient, CreateCardRequest } from '../services/amzKeysService'
import { pollAndActivateAmzCard } from '../services/cardActivationService'

function getFee(limit: number, vipLevel: number): number {
  const fees: Record<number, number> = { 1: 44, 2: 39.6, 3: 33, 4: 26.4 }
  return fees[vipLevel] || fees[1]
}

export const customerController = {
  getState: async (req: AuthRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        include: {
          cards: { orderBy: { createdAt: 'desc' }, take: 50 },
          transactions: { orderBy: { timestamp: 'desc' }, take: 100 },
          kyc: true
        }
      })

      if (!user) return res.status(404).json({ error: '用户不存在' })

      res.json({
        success: true,
        profile: {
          id: user.id, name: user.name, email: user.email, avatar: user.avatar,
          walletBalance: user.walletBalance, vipLevel: user.vipLevel,
          identityClass: user.identityClass, upstreamName: user.upstreamName,
          monthlySpend: user.monthlySpend
        },
        cards: user.cards,
        transactions: user.transactions,
        kyc: user.kyc || { status: 'not_submitted', documentType: null, fileName: null },
        twoFactor: { enabled: user.twoFactorEnabled, secret: null, qrUrl: null }
      })
    } catch (err) {
      console.error('Get state error:', err)
      res.status(500).json({ error: '获取状态失败' })
    }
  },

  getProfile: async (req: AuthRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { id: true, name: true, email: true, avatar: true, walletBalance: true, vipLevel: true, identityClass: true, upstreamName: true, monthlySpend: true }
      })
      res.json({ success: true, profile: user })
    } catch (err) { res.status(500).json({ error: '获取资料失败' }) }
  },

  updateProfile: async (req: AuthRequest, res: Response) => {
    try {
      const { name, avatar } = req.body
      const user = await prisma.user.update({ where: { id: req.user!.id }, data: { name, avatar } })
      res.json({ success: true, profile: user })
    } catch (err) { res.status(500).json({ error: '更新失败' }) }
  },

  getCards: async (req: AuthRequest, res: Response) => {
    try {
      const cards = await prisma.card.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } })
      res.json({ success: true, cards })
    } catch (err) { res.status(500).json({ error: '获取卡片失败' }) }
  },

  getCard: async (req: AuthRequest, res: Response) => {
    try {
      const card = await prisma.card.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
      if (!card) return res.status(404).json({ error: '卡片不存在' })
      res.json({ success: true, card })
    } catch (err) { res.status(500).json({ error: '获取卡片失败' }) }
  },

  createCard: async (req: AuthRequest, res: Response) => {
    try {
      const { bin, limit, nickname, label } = req.body
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
      if (!user) return res.status(404).json({ error: '用户不存在' })

      const binConfig = await prisma.binConfig.findUnique({ where: { bin } })
      if (!binConfig || binConfig.status !== 'active') return res.status(400).json({ error: '选中的 BIN 通道不可用' })

      const fee = getFee(limit, user.vipLevel)
      if (user.walletBalance < limit + fee) return res.status(400).json({ error: '余额不足，无法支付额度+手续费' })

      const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
      const routingType = binConfig.routingType || 'manual'

      const card = await prisma.card.create({
        data: {
          userId: user.id, number: '•••• •••• •••• ••••', cvv: '•••', expiry: '••/••',
          brand: binConfig.network, bin, nickname: nickname || 'Pending Card', balance: 0, limit,
          status: 'pending', label: label || 'General', routingType, applicationId
        }
      })

      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { walletBalance: { decrement: limit + fee } } }),
        prisma.transaction.create({
          data: { userId: user.id, cardId: null, cardNickname: nickname || 'Pending Card', merchant: 'Card Issuance Allocation', amount: -(limit + fee), currency: 'USD', status: 'pending', description: `Card application ${applicationId} - limit $${limit} + fee $${fee}` }
        })
      ])

      if (routingType === 'auto') {
        const client = getAmzClient()
        if (!client) {
          await prisma.$transaction([
            prisma.user.update({ where: { id: user.id }, data: { walletBalance: { increment: limit + fee } } }),
            prisma.card.delete({ where: { id: card.id } }),
            prisma.transaction.deleteMany({ where: { description: { contains: applicationId } } })
          ])
          return res.status(503).json({ error: 'AmzKeys 自动通道未配置' })
        }

        try {
          const createReq: CreateCardRequest = {
            bin,
            card_type: binConfig.network === 'Visa' ? 'VISA' : 'MASTERCARD',
            amount: limit,
            currency: 'USD',
            remark: nickname || label
          }
          const createResp = await client.createCard(createReq)

          if (createResp.code !== 0 || !createResp.data?.task_id) {
            throw new Error(createResp.msg || 'AmzKeys createCard failed')
          }

          const taskId = createResp.data.task_id
          const orderNo = createResp.data.order_no

          await prisma.card.update({
            where: { id: card.id },
            data: { amzTaskId: taskId, amzOrderNo: orderNo }
          })

          // Fire and forget polling
          pollAndActivateAmzCard(taskId, applicationId, limit, binConfig.network as 'Visa' | 'Mastercard')
            .catch(err => console.error('[AmzKeys] Polling error:', err))

          return res.json({
            success: true,
            application: { id: applicationId, status: 'PENDING', statusText: '发卡行通道处理中 / Processing...', estimatedReady: new Date(Date.now() + 5 * 60 * 1000).toISOString() }
          })
        } catch (err: any) {
          await prisma.$transaction([
            prisma.user.update({ where: { id: user.id }, data: { walletBalance: { increment: limit + fee } } }),
            prisma.card.delete({ where: { id: card.id } }),
            prisma.transaction.deleteMany({ where: { description: { contains: applicationId } } })
          ])
          return res.status(502).json({ error: `AmzKeys create failed: ${err.message}` })
        }
      }

      // Manual channel
      res.json({
        success: true,
        application: { id: applicationId, status: 'PENDING', statusText: '银行系统受理中 / Allocating...', estimatedReady: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
      })
    } catch (err) {
      console.error('Create card error:', err)
      res.status(500).json({ error: '开卡申请失败' })
    }
  },

  cardAction: async (req: AuthRequest, res: Response) => {
    try {
      const { cardId, action } = req.params
      const card = await prisma.card.findFirst({ where: { id: cardId, userId: req.user!.id } })
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
          await prisma.card.update({ where: { id: cardId }, data: { status: 'cancelled' } })
          if (card.status === 'active' && card.balance > 0) {
            await prisma.user.update({ where: { id: req.user!.id }, data: { walletBalance: { increment: card.balance } } })
            await prisma.transaction.create({
              data: { userId: req.user!.id, cardId: card.id, cardLast4: card.number.slice(-4), cardNickname: card.nickname, merchant: 'Card Cancel Refund', amount: card.balance, currency: 'USD', status: 'success', description: `Card ${card.nickname} cancelled, balance refunded` }
            })
          }
          break
        }
        case 'adjust_limit': {
          const { newLimit } = req.body
          const numLimit = parseFloat(newLimit)
          if (isNaN(numLimit) || numLimit < 10) return res.status(400).json({ error: '最低额度 $10' })
          if (card.status !== 'active') return res.status(400).json({ error: '仅激活卡可调整额度' })
          if (numLimit < card.balance) return res.status(400).json({ error: '额度不能低于当前余额' })
          await prisma.card.update({ where: { id: cardId }, data: { limit: numLimit } })
          break
        }
        case 'topup': {
          const { amount } = req.body
          const numAmount = parseFloat(amount)
          if (isNaN(numAmount) || numAmount < 1) return res.status(400).json({ error: '充值金额无效' })
          if (card.status !== 'active') return res.status(400).json({ error: '仅激活卡可充值' })
          await prisma.card.update({ where: { id: cardId }, data: { balance: { increment: numAmount } } })
          await prisma.transaction.create({
            data: { userId: req.user!.id, cardId: card.id, cardLast4: card.number.slice(-4), cardNickname: card.nickname, merchant: 'Card Topup', amount: numAmount, currency: 'USD', status: 'success', description: `Topup to ${card.nickname}` }
          })
          break
        }
        case 'withdraw': {
          const { amount } = req.body
          const numAmount = parseFloat(amount)
          if (isNaN(numAmount) || numAmount < 1) return res.status(400).json({ error: '提现金额无效' })
          if (card.status !== 'active') return res.status(400).json({ error: '仅激活卡可提现' })
          if (card.balance < numAmount) return res.status(400).json({ error: '卡片余额不足' })
          await prisma.card.update({ where: { id: cardId }, data: { balance: { decrement: numAmount } } })
          await prisma.user.update({ where: { id: req.user!.id }, data: { walletBalance: { increment: numAmount } } })
          await prisma.transaction.create({
            data: { userId: req.user!.id, cardId: card.id, cardLast4: card.number.slice(-4), cardNickname: card.nickname, merchant: 'Card Withdrawal', amount: -numAmount, currency: 'USD', status: 'success', description: `Withdrawal from ${card.nickname}` }
          })
          break
        }
        default:
          return res.status(400).json({ error: '不支持的操作' })
      }

      const updated = await prisma.card.findUnique({ where: { id: cardId } })
      res.json({ success: true, card: updated })
    } catch (err) {
      console.error('Card action error:', err)
      res.status(500).json({ error: '操作失败' })
    }
  },

  getTransactions: async (req: AuthRequest, res: Response) => {
    try {
      const { page = 1, limit = 20 } = req.query
      const skip = (Number(page) - 1) * Number(limit)
      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({ where: { userId: req.user!.id }, orderBy: { timestamp: 'desc' }, skip, take: Number(limit) }),
        prisma.transaction.count({ where: { userId: req.user!.id } })
      ])
      res.json({ success: true, data: transactions, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) })
    } catch (err) { res.status(500).json({ error: '获取交易记录失败' }) }
  },

  getKYC: async (req: AuthRequest, res: Response) => {
    try {
      const kyc = await prisma.kycRecord.findUnique({ where: { userId: req.user!.id } })
      res.json({ success: true, kyc: kyc || { status: 'not_submitted', documentType: null, fileName: null } })
    } catch (err) { res.status(500).json({ error: '获取 KYC 失败' }) }
  },

  submitKYC: async (req: AuthRequest, res: Response) => {
    try {
      const { documentType, fileName, legalName, documentNumber, birthDate, nationality, residentialAddress, files } = req.body
      const required = ['front', 'back', 'selfie', 'addressProof']
      if (!documentType || !legalName || !documentNumber || !birthDate || !nationality || !residentialAddress || !files || !required.every(k => files[k])) {
        return res.status(400).json({ error: 'KYC 提交需要身份字段加上正反面证件、自拍、住址证明' })
      }

      const kyc = await prisma.kycRecord.upsert({
        where: { userId: req.user!.id },
        create: { userId: req.user!.id, status: 'pending', documentType, fileName, legalName, documentNumber, birthDate, nationality, residentialAddress, files, submittedAt: new Date(), feedback: 'KYC package submitted. Operator compliance review is pending.' },
        update: { status: 'pending', documentType, fileName, legalName, documentNumber, birthDate, nationality, residentialAddress, files, submittedAt: new Date(), feedback: 'KYC package submitted. Operator compliance review is pending.' }
      })
      res.json({ success: true, kyc })
    } catch (err) { res.status(500).json({ error: '提交 KYC 失败' }) }
  },

  get2FA: async (req: AuthRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { twoFactorEnabled: true } })
      res.json({ success: true, enabled: user?.twoFactorEnabled || false })
    } catch (err) { res.status(500).json({ error: '获取 2FA 状态失败' }) }
  },

  get3DSPool: async (req: AuthRequest, res: Response) => {
    try {
      const client = getAmzClient()
      if (!client) return res.status(503).json({ error: 'AmzKeys 通道未配置' })
      const resp = await client.getAuthCodePool()
      if (resp.code !== 10000) throw new Error(resp.msg || 'AmzKeys authCode pool error')
      res.json({ success: true, items: resp.data?.items || [], total: resp.data?.total || 0 })
    } catch (err: any) {
      console.error('[AmzKeys] 3DS pool fetch failed:', err)
      res.status(502).json({ error: `Fetch 3DS pool failed: ${err.message}` })
    }
  },

  recharge: async (req: AuthRequest, res: Response) => {
    try {
      const { amount, method } = req.body
      const numAmount = parseFloat(amount)
      if (isNaN(numAmount) || numAmount < 20) return res.status(400).json({ error: '最低充值金额 $20' })

      const config = await prisma.adminConfig.findFirst()
      if (!config?.fundingAddress) return res.status(503).json({ error: '管理员未配置充值地址' })

      // Return payment info for frontend to show QR code / address
      const paymentId = `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const expiresAt = Date.now() + 30 * 60 * 1000 // 30 min

      res.json({
        success: true,
        payment: {
          id: paymentId,
          address: config.fundingAddress,
          amount: numAmount.toFixed(2),
          method: method || 'USDT',
          network: 'TRC-20',
          qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(config.fundingAddress)}`,
          expiresAt,
          memo: `VCC Recharge ${paymentId}`
        }
      })
    } catch (err) { res.status(500).json({ error: '充值失败' }) }
  },

  confirmRecharge: async (req: AuthRequest, res: Response) => {
    try {
      const { paymentId, txHash } = req.body
      // In production, verify on-chain transaction
      // For now, mock: credit wallet
      const amount = 100 // Would come from payment record
      await prisma.user.update({ where: { id: req.user!.id }, data: { walletBalance: { increment: amount } } })
      await prisma.transaction.create({
        data: { userId: req.user!.id, cardId: null, merchant: 'Wallet Recharge', amount, currency: 'USDT', status: 'success', description: `Recharge ${paymentId} confirmed` }
      })
      res.json({ success: true, message: '充值到账' })
    } catch (err) { res.status(500).json({ error: '确认充值失败' }) }
  }
}
