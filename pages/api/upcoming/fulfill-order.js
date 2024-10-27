import { buffer } from 'micro'
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
  const body = (await buffer(req)).toString()
  const {
    admin_graphql_api_id: order_gid,
    name: order_number,
    note_attributes,
    tags,
    financial_status
  } = JSON.parse(body)
  const currentTags = tags.split(', ')

  res.write(`Received hook for ${order_number}`)

  // nothing to process when:
  // - no attachment
  // - email already sent
  // - not yet paid
  if (
    !note_attributes?.[0]?.value ||
    currentTags.includes('Entregue') ||
    financial_status !== 'paid'
  ) return res.status(200).send('Not yet ready to be processed')

  // remove notification and timer tags as the order will be processed now
  const isNotified = currentTags.includes('notified')
  const filteredTags = currentTags.filter((tag) => !tag.startsWith('timer:') && !['notification', 'notified'].includes(tag))
  const nextTags = [...filteredTags, 'Entregue']

  const getOrderOperation = `
    query GetOrder($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 1, query: "-status:closed") {
          nodes {
            id
          }
        }
      }
    }
  `
  const { data: { order: { fulfillmentOrders: { nodes: [{ id: fulfillmentOrderId }] } } } } = await client.request(getOrderOperation, {
    variables: {
      id: order_gid
    }
  })

  const bulkUpdate = `
    mutation BulkUpdate(
      $input: OrderInput!
      $fulfillment: FulfillmentV2Input!
    ) {
      orderUpdate(input: $input) {
        userErrors {
          field
          message
        }
      }
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        userErrors {
          field
          message
        }
      }
    }
  `
  const { data, errors } = await client.request(bulkUpdate, {
    variables: {
      input: {
        id: order_gid,
        tags: nextTags
      },
      fulfillment: {
        lineItemsByFulfillmentOrder: [{
          fulfillmentOrderId
        }]
      }
    }
  })

  if (data?.orderUpdate?.userErrors.length || data?.fulfillmentCreateV2?.userErrors.length || errors) {
    const errorOutput = `
      GraphQL errors:
      ${JSON.stringify(data, null, ' ')}

      General Errors:
      ${JSON.stringify(errors, null, ' ')}
    `
    console.log(errorOutput)

    await transport.sendMail({
      from: fromEmail,
      to: toEmail,
      subject: `[ALERTA] Order ${order_number}: Houve um erro ao fazer fulfill da order`,
      text: errorOutput
    })

    return res.status(200).send('Ok')
  }

  res.write('Shopify tags and fulfillment updated')

  // send an email stating that the delayed order is now processed
  if (isNotified) {
    await transport.sendMail({
      from: fromEmail,
      to: toEmail,
      subject: `[ALERTA] Order ${order_number}: A order já está resolvida`
    })
  }

  res.status(200).send('Processed')
}

export const config = {
  api: {
    bodyParser: false,
  },
}