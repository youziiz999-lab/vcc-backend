import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import speakeasy from 'speakeasy'
import QRCode from 'qrcode'
import { prisma } from '../config/prisma'
import { config } from '../config'
import { AuthRequest } from '../middleware/auth'

const generateTokens = (userId: string, email: string, role: 'customer' | 'admin') => {
  const accessToken = jwt.sign(
    { id: userId, email, role },
    config.jwt.secret,
    { expiresIn: '30d' as any }
  )
  const refreshToken = jwt.sign(
    { id: userId, email, role, type: 'refresh' },
    config.jwt.secret,
    { expiresIn: '90d' as any }
  )
  return { accessToken, refreshToken }
}

export const authController = {
  register: async (req: Request, res: Response) => {
    try {
      const { email, password, name, inviteCode } = req.body
      
      if (!email || !password || !name) {
        return res.status(400).json({ error: '邮箱、密码、姓名为必填项' })
      }
      
      if (password.length < 8) {
        return res.status(400).json({ error: '密码至少8位' })
      }

      const existing = await prisma.user.findUnique({ where: { email } })
      if (existing) {
        return res.status(409).json({ error: '邮箱已被注册' })
      }

      const passwordHash = await bcrypt.hash(password, 12)
      
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name,
          role: 'customer',
          vipLevel: 1,
          walletBalance: 0
        }
      })

      const { accessToken, refreshToken } = generateTokens(user.id, user.email, 'customer')
      
      res.status(201).json({
        success: true,
        token: accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          walletBalance: user.walletBalance,
          vipLevel: user.vipLevel
        }
      })
    } catch (err) {
      console.error('Register error:', err)
      res.status(500).json({ error: '注册失败' })
    }
  },

  login: async (req: Request, res: Response) => {
    try {
      const { email, password, rememberMe } = req.body
      
      if (!email || !password) {
        return res.status(400).json({ error: '邮箱和密码为必填项' })
      }

      const user = await prisma.user.findUnique({ where: { email } })
      if (!user) {
        return res.status(401).json({ error: '邮箱或密码错误' })
      }

      const valid = await bcrypt.compare(password, user.passwordHash)
      if (!valid) {
        return res.status(401).json({ error: '邮箱或密码错误' })
      }

      if (user.twoFactorEnabled) {
        const { code } = req.body
        if (!code || !/^\d{6}$/.test(code)) {
          return res.status(400).json({ error: '需要6位验证码', requires2FA: true })
        }
        const verified = speakeasy.totp.verify({
          secret: user.twoFactorSecret!,
          encoding: 'base32',
          token: code,
          window: 1
        })
        if (!verified) {
          return res.status(401).json({ error: '验证码错误' })
        }
      }

      const { accessToken, refreshToken } = generateTokens(user.id, user.email, user.role as any)
      
      res.json({
        success: true,
        token: accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          walletBalance: user.walletBalance,
          vipLevel: user.vipLevel,
          identityClass: user.identityClass,
          upstreamName: user.upstreamName,
          monthlySpend: user.monthlySpend,
          twoFactorEnabled: user.twoFactorEnabled
        }
      })
    } catch (err) {
      console.error('Login error:', err)
      res.status(500).json({ error: '登录失败' })
    }
  },

  me: async (req: AuthRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          id: true, email: true, name: true, avatar: true,
          walletBalance: true, vipLevel: true, identityClass: true,
          upstreamName: true, monthlySpend: true, twoFactorEnabled: true,
          createdAt: true
        }
      })
      if (!user) {
        return res.status(404).json({ error: '用户不存在' })
      }
      res.json({ success: true, user })
    } catch (err) {
      console.error('Me error:', err)
      res.status(500).json({ error: '获取用户信息失败' })
    }
  },

  refresh: async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body
      if (!refreshToken) {
        return res.status(400).json({ error: '缺少刷新令牌' })
      }

      const decoded = jwt.verify(refreshToken, config.jwt.secret) as {
        id: string
        email: string
        role: 'customer' | 'admin'
        type: string
      }

      if (decoded.type !== 'refresh') {
        return res.status(401).json({ error: '无效的刷新令牌' })
      }

      const user = await prisma.user.findUnique({ where: { id: decoded.id } })
      if (!user) {
        return res.status(401).json({ error: '用户不存在' })
      }

      const { accessToken, refreshToken: newRefreshToken } = generateTokens(
        user.id, user.email, user.role as any
      )

      res.json({ success: true, token: accessToken, refreshToken: newRefreshToken })
    } catch (err) {
      res.status(401).json({ error: '刷新令牌无效或已过期' })
    }
  },

  logout: async (req: AuthRequest, res: Response) => {
    res.json({ success: true, message: '已登出' })
  },

  enable2FA: async (req: AuthRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
      if (!user) return res.status(404).json({ error: '用户不存在' })

      if (user.twoFactorEnabled) {
        return res.status(400).json({ error: '2FA 已启用' })
      }

      const secret = speakeasy.generateSecret({
        name: `VCC:${user.email}`,
        length: 20
      })

      const qrUrl = await QRCode.toDataURL(secret.otpauth_url!)

      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorSecret: secret.base32 }
      })

      res.json({
        success: true,
        secret: secret.base32,
        qrUrl,
        message: '请使用验证器应用扫描二维码，然后输入验证码完成启用'
      })
    } catch (err) {
      console.error('Enable 2FA error:', err)
      res.status(500).json({ error: '启用 2FA 失败' })
    }
  },

  verify2FA: async (req: AuthRequest, res: Response) => {
    try {
      const { code } = req.body
      if (!code || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: '需要6位验证码' })
      }

      const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
      if (!user || !user.twoFactorSecret) {
        return res.status(400).json({ error: '2FA 未配置' })
      }

      const verified = speakeasy.totp.verify({
        secret: user.twoFactorSecret,
        encoding: 'base32',
        token: code,
        window: 1
      })

      if (!verified) {
        return res.status(401).json({ error: '验证码错误' })
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true }
      })

      res.json({ success: true, message: '2FA 已启用' })
    } catch (err) {
      console.error('Verify 2FA error:', err)
      res.status(500).json({ error: '验证失败' })
    }
  },

  disable2FA: async (req: AuthRequest, res: Response) => {
    try {
      const { code } = req.body
      if (!code || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: '需要6位验证码' })
      }

      const user = await prisma.user.findUnique({ where: { id: req.user!.id } })
      if (!user || !user.twoFactorSecret) {
        return res.status(400).json({ error: '2FA 未启用' })
      }

      const verified = speakeasy.totp.verify({
        secret: user.twoFactorSecret,
        encoding: 'base32',
        token: code,
        window: 1
      })

      if (!verified) {
        return res.status(401).json({ error: '验证码错误' })
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: false, twoFactorSecret: null }
      })

      res.json({ success: true, message: '2FA 已禁用' })
    } catch (err) {
      console.error('Disable 2FA error:', err)
      res.status(500).json({ error: '禁用失败' })
    }
  }
}
