import { buffer } from 'micro'
import nodemailer from 'nodemailer'
import { createAdminApiClient } from '@shopify/admin-api-client'
import * as emailTemplates from '../../email-templates'

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
    const body = (await buffer(req)).toString();
    const {
        admin_graphql_api_id: order_gid,
        contact_email,
        name: order_number,
        line_items,
        note_attributes,
        tags,
        customer_locale,
        financial_status,
    } = JSON.parse(body);
    const lang = customer_locale === "pt-PT" ? "pt" : "en";
    const currentTags = tags.split(", ");

    console.log(`Order Update hook for ${order_number}`);

    // add notification and timer (now + 15min) tags when is paid but no file attached
    if (
        !note_attributes?.[0]?.value &&
        financial_status === "paid" &&
        !currentTags.includes("notification")
    ) {
        const timeout = 15 * 60 * 10000;
        const timer = new Date().getTime() + timeout;
        const nextTags = [...currentTags, "notification", `timer:${timer}`];
        const orderUpdate = `
          mutation OrderUpdate($input: OrderInput!) {
            orderUpdate(input: $input) {
              userErrors {
                field
                message
              }
            }
          }
        `;
        const { data, errors } = await client.request(orderUpdate, {
            variables: {
                input: {
                    id: order_gid,
                    tags: nextTags,
                },
            },
        });

        if (errors) {
            await transport.sendMail({
                from: fromEmail,
                to: toEmail,
                subject: `[ALERTA] Order ${order_number}: Falhou ao definir notificação`,
                text: JSON.stringify({ data, errors }, null, " "),
            });
        }
    }

    // nothing to process when:
    // - no attachment
    // - email already sent
    // - not yet paid
    if (
        !note_attributes?.[0]?.value ||
        currentTags.includes("Entregue") ||
        financial_status !== "paid"
    ) {
        return res.status(200).send("Ok");
    }

    const to = isDebug ? toEmail : contact_email;
    const bcc = !isDebug ? toEmail : undefined;
    const subject = `${emailTemplates[lang].subject} ${order_number} ${
        isDebug ? `(to: ${contact_email})` : ""
    }`.trimEnd();
    const totalOrderCount = line_items.reduce(
        (acc, line) => acc + line.quantity,
        0
    );
    const hasMissingFiles = totalOrderCount < note_attributes.length;
    let nextTags = [];

    console.log(
        `Send "${order_number}" email to "${contact_email}" (locale: "${customer_locale}" :: tags: "${tags}") with "${note_attributes?.[0]?.value}"`
    );

    for (const [index, img] of note_attributes.entries()) {
        const emailParts =
            note_attributes.length === 1
                ? ""
                : `(${index + 1}/${note_attributes.length})`;
        const imgName = img.value.split("/").pop();
        const fileParts = note_attributes.length === 1 ? "" : `_${index + 1}`;

        // file already sent, skip it
        if (currentTags.includes(`sent:img:${imgName}`)) continue;

        const email = await transport.sendMail({
            from: fromEmail,
            to: to,
            bcc: bcc,
            subject: `${subject} ${emailParts}`,
            text: emailTemplates[lang].text,
            html: emailTemplates[lang].html,
            attachments: [
                ...emailTemplates[lang].attachments,
                {
                    filename: `${order_number}${fileParts}.png`,
                    path: img.value,
                },
            ],
        });

        if (!email.messageId) {
            console.log(
                "Error sending email: ",
                JSON.stringify(email, null, " ")
            );

            await transport.sendMail({
                from: fromEmail,
                to: toEmail,
                subject: `[ALERTA] Order ${order_number}: Houve um erro no envio do email`,
            });

            return res.status(200).send("Ok");
        }

        // update `nextTags` to add the file sent in order to be skipped next time
        nextTags.push(`sent:img:${imgName}`);

        console.log(`Email sent: ${email.messageId}`);
    }

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
    `;
    const {
        data: {
            order: {
                fulfillmentOrders: {
                    nodes: [{ id: fulfillmentOrderId }],
                },
            },
        },
    } = await client.request(getOrderOperation, {
        variables: {
            id: order_gid,
        },
    });
    console.log(
        `FulfillmentOrder: "${fulfillmentOrderId}" for ID: "${order_gid}"`
    );

    // if hasMissingFiles update tags, otherwise update tags and fulfill order
    let bulkUpdate, data, errors;
    if (hasMissingFiles) {
        bulkUpdate = `
          mutation BulkUpdate(
            $input: OrderInput!
          ) {
            orderUpdate(input: $input) {
              userErrors {
                field
                message
              }
            }
          }
        `;
        ({ data, errors } = await client.request(bulkUpdate, {
            variables: {
                input: {
                    id: order_gid,
                    tags: nextTags,
                },
            },
        }));
    } else {
        // remove notification and timer tags as the order is now processed
        const filteredTags = currentTags.filter(
            (tag) =>
                !tag.startsWith("timer:") &&
                !tag.startsWith("sent:img:") &&
                !["notification", "notified"].includes(tag)
        );
        nextTags.push(...filteredTags, "Entregue");

        console.log(`nextTags: ${nextTags}`);

        bulkUpdate = `
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
        `;
        ({ data, errors } = await client.request(bulkUpdate, {
            variables: {
                input: {
                    id: order_gid,
                    tags: nextTags,
                },
                fulfillment: {
                    lineItemsByFulfillmentOrder: [
                        {
                            fulfillmentOrderId,
                        },
                    ],
                },
            },
        }));
    }

    if (
        data?.orderUpdate?.userErrors.length ||
        data?.fulfillmentCreateV2?.userErrors.length ||
        errors
    ) {
        const errorOutput = `
          GraphQL errors:
          ${JSON.stringify(data, null, " ")}

          General Errors:
          ${JSON.stringify(errors, null, " ")}
        `;
        console.log(errorOutput);

        await transport.sendMail({
            from: fromEmail,
            to: toEmail,
            subject: `[ALERTA] Order ${order_number}: Houve um erro ao actualizar a order (hasMissingFiles: ${hasMissingFiles})`,
            text: errorOutput,
        });

        return res.status(200).send("Ok");
    }

    if (hasMissingFiles && !errors) {
        console.log("Shopify tags updated");
    } else if (!hasMissingFiles && !errors) {
        console.log("Shopify tags and fulfillment updated");

        // send an email stating that the order is now processed
        const isNotified = currentTags.includes("notified");
        if (isNotified) {
            await transport.sendMail({
                from: fromEmail,
                to: toEmail,
                subject: `[ALERTA] Order ${order_number}: A order já está resolvida`,
            });
        }
    } else {
        console.log(
            "errors:",
            data?.orderUpdate?.userErrors,
            data?.fulfillmentCreateV2?.userErrors,
            errors
        );
        return res.status(500).send("Error");
    }

    res.status(200).send("Ok");
}

export const config = {
  api: {
    bodyParser: false,
  },
}