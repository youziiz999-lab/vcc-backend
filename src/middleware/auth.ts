import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config'
import { prisma } from '../config/prisma'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    role: 'customer' | 'admin'
  }
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未提供认证令牌' })
    }

    const token = authHeader.slice(7)
    const decoded = jwt.verify(token, config.jwt.secret) as {
      id: string
      email: string
      role: 'customer' | 'admin'
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true }
    })

    if (!user) {
      return res.status(401).json({ error: '用户不存在' })
    }

    req.user = { id: user.id, email: user.email, role: user.role as 'customer' | 'admin' }
    next()
  } catch (err) {
    return res.status(401).json({ error: '认证令牌无效或已过期' })
  }
}

export const adminMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' })
  }
  next()
}

export const optionalAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return next()
    }

    const token = authHeader.slice(7)
    const decoded = jwt.verify(token, config.jwt.secret) as {
      id: string
      email: string
      role: 'customer' | 'admin'
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true }
    })

    if (user) {
    req.user = { id: user.id, email: user.email, role: user.role as 'customer' | 'admin' }
    }
    next()
  } catch {
    next()
  }
}
