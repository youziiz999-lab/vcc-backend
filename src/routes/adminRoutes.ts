import { Router } from 'express'
import { adminController } from '../controllers/adminController'
import { authMiddleware, adminMiddleware } from '../middleware/auth'

const router = Router()

router.use(authMiddleware, adminMiddleware)

// Dashboard & Config
router.get('/state', adminController.getState)
router.get('/config', adminController.getConfig)
router.put('/config', adminController.updateConfig)

// BIN Management
router.get('/bins', adminController.getBins)
router.post('/bins', adminController.createBin)
router.put('/bins/:bin', adminController.updateBin)
router.delete('/bins/:bin', adminController.deleteBin)
router.patch('/bins/:bin/status', adminController.toggleBinStatus)

// Transaction Management (Manual Ledger)
router.post('/transactions', adminController.createTransaction)
router.post('/transactions/batch', adminController.batchTransactions)

// Card Management
router.post('/cards/:id/activate', adminController.activateCard)
router.post('/cards/:cardId/action/:action', adminController.adminCardAction)
router.post('/cards/:cardId/retry-amz', adminController.retryAmzCard)

// Reconciliation
router.get('/reconciliation', adminController.getReconciliation)
router.post('/reconciliation/:id/review', adminController.reviewReconciliation)

// KYC Review
router.post('/kyc/:userId/review', adminController.reviewKYC)

// User Management
router.get('/users', adminController.getUsers)
router.put('/users/:userId', adminController.updateUser)

// Full lists with filters
router.get('/cards', adminController.getCards)
router.get('/transactions', adminController.getTransactions)

export default router
