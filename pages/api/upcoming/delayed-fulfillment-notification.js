import nodemailer from 'nodemailer'
import { createAdminApiClient } from '@shopify/admin-api-client'

const isDebug = process.env.APP_MODE !== 'production'
const fromEmail = '"Momentus Shop" <info@momentus.shop>'
const toEmail = isDebug ? 'ricardo.ferreira@wizardformula.pt' : 'info@momentus.shop'

const [storeDomain, accessToken] = process.env.SHOPIFY_AUTH.split(':')
const client = createAdminApiClient({
  apiVersion: '2024-01',
  storeDomain,
  accessToken
})

const transport = nodemailer.createTransport(JSON.parse(process.env.SMTP_CONNECTION))

export default async (req, res) => {
  const authHeader = req.headers['authorization']
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ success: false })
  }

  const getOrdersOperation = `
    query GetOrders($query: String) {
      orders(first: 1, query: $query) {
        nodes {
          id
          name
          tags
          fullyPaid
        }
      }
    }
  `
  const { data: { orders: { nodes } } } = await client.request(getOrdersOperation, {
    variables: {
      query: 'tag:notification'
    }
  })

  // filter orders where timeout passed to:
  // - send email
  // - add 'notified' tag
  for (const order of nodes) {
    const shouldSendEmail = order.tags.some((tag) => {
      if (tag.startsWith('timer:')) {
        const [,timer] = tag.split(':')
        const currentTimestamp = (new Date).getTime()
        return timer <= currentTimestamp
      }

      return false
    })

    if (order.tags.includes('notified') || !order.fullyPaid || !shouldSendEmail) continue

    await transport.sendMail({
      from: fromEmail,
      to: toEmail,
      subject: `[ALERTA] Order ${order.name}: Continua sem ficheiro anexo`
    })

    const nextTags = [...order.tags, 'notified']
    const orderUpdateOperation = `
      mutation OrderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `
    const { data, errors } = await client.request(orderUpdateOperation, {
      variables: {
        input: {
          id: order.id,
          tags: nextTags
        }
      }
    })

    if (data?.userErrors || errors) {
      await transport.sendMail({
        from: fromEmail,
        to: toEmail,
        subject: `[ALERTA] Order ${order.name}: Falhou a processar notificação`,
        text: JSON.stringify(data?.userErrors ?? errors, null, ' ')
      })
    }
  }
 
  return res.status(200).json({ success: true })
}