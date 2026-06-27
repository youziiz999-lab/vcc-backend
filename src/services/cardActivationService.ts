import { prisma } from '../config/prisma'
import { getAmzClient } from './amzKeysService'

async function pollAndActivateAmzCard(
  taskId: string,
  applicationId: string,
  limitValue: number,
  network: 'Visa' | 'Mastercard'
) {
  const client = getAmzClient()
  if (!client) return

  try {
    const cardInfo = await client.pollTaskUntilComplete(taskId, { intervalMs: 10000, maxAttempts: 60 })
    const card = await prisma.card.findFirst({ where: { applicationId } })
    if (!card || card.status !== 'pending') return

    const [month, year] = cardInfo.valid_date.split('/')
    const expiry = `${month.padStart(2, '0')}/${year.slice(-2)}`

    await prisma.card.update({
      where: { id: card.id },
      data: {
        number: cardInfo.card_no,
        cvv: cardInfo.cvv,
        expiry,
        balance: limitValue,
        limit: limitValue,
        status: 'active',
        billingAddress: '',
        issuedAt: new Date(),
        routingType: null,
        amzTaskId: null,
        amzOrderNo: null
      }
    })

    await prisma.transaction.updateMany({
      where: { description: { contains: applicationId } },
      data: { status: 'success' }
    })

    console.log('[AmzKeys] Card auto-activated:', cardInfo.card_no.slice(-4))
  } catch (err) {
    console.error('[AmzKeys] Auto-activation failed:', err)
    await prisma.card.updateMany({
      where: { applicationId, status: 'pending' },
      data: { status: 'cancelled' }
    })
  }
}

export { pollAndActivateAmzCard }
