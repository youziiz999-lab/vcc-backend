import { Router } from 'express'
import { customerController } from '../controllers/customerController'
import { authMiddleware } from '../middleware/auth'

const router = Router()

router.use(authMiddleware)

router.get('/state', customerController.getState)
router.get('/profile', customerController.getProfile)
router.put('/profile', customerController.updateProfile)

router.get('/cards', customerController.getCards)
router.get('/cards/:id', customerController.getCard)
router.post('/cards', customerController.createCard)
router.post('/cards/:cardId/action/:action', customerController.cardAction)

router.get('/transactions', customerController.getTransactions)

router.get('/kyc', customerController.getKYC)
router.post('/kyc', customerController.submitKYC)

router.get('/2fa', customerController.get2FA)

router.get('/3ds-pool', customerController.get3DSPool)

router.post('/wallet/recharge', customerController.recharge)
router.post('/wallet/recharge/confirm', customerController.confirmRecharge)

export default router
