import { Router } from 'express'
import { authController } from '../controllers/authController'
import { authMiddleware } from '../middleware/auth'

const router = Router()

router.post('/register', authController.register)
router.post('/login', authController.login)
router.post('/refresh', authController.refresh)
router.post('/logout', authMiddleware, authController.logout)
router.get('/me', authMiddleware, authController.me)

router.post('/2fa/enable', authMiddleware, authController.enable2FA)
router.post('/2fa/verify', authMiddleware, authController.verify2FA)
router.post('/2fa/disable', authMiddleware, authController.disable2FA)

export default router
