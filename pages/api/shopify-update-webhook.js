import { buffer } from "micro";
import nodemailer from "nodemailer";
import { createAdminApiClient } from "@shopify/admin-api-client";
import * as emailTemplates from "../../email-templates";

const isDebug = process.env.APP_MODE !== "production";
const fromEmail = '"Momentus Shop" <info@momentus.shop>';
const toEmail = isDebug
    ? "ricardo.ferreira@wizardformula.pt"
    : "info@momentus.shop";

const [storeDomain, accessToken] = process.env.SHOPIFY_AUTH.split(":");
const client = createAdminApiClient({
    apiVersion: "2024-01",
    storeDomain,
    accessToken,
});

const transport = nodemailer.createTransport(
    JSON.parse(process.env.SMTP_CONNECTION)
);

function getShortFileName(filename) {
    const parts = filename.split("/").pop().replace(".png", "").split("-");
    return `${parts[0]}-${[parts[parts.length - 1]]}`;
}

function countImageUrls(note_attributes) {
    return note_attributes.reduce(
        (acc, attr) => acc + (attr.value.length > 0 ? 1 : 0),
        0
    );
}

async function addNotificationTimer(order_gid, currentTags) {
    const timeout = 15 * 60 * 1000;
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

async function sendEmailsToClient(
    order_number,
    contact_email,
    note_attributes,
    lang,
    currentTags,
    nextTags
) {
    const to = isDebug ? toEmail : contact_email;
    const bcc = !isDebug ? toEmail : undefined;
    const subject = `${emailTemplates[lang].subject} ${order_number} ${
        isDebug ? `(to: ${contact_email})` : ""
    }`.trimEnd();

    for (const [index, img] of note_attributes.entries()) {
        if (!img.value) {
            console.log(`skipping email - no url yet for (${img.name})`);
            continue;
        }

        const emailParts =
            note_attributes.length === 1
                ? ""
                : `(${index + 1}/${note_attributes.length})`;
        const imgName = getShortFileName(img.value);
        const fileParts = note_attributes.length === 1 ? "" : `_${index + 1}`;

        // file already sent, skip it
        if (currentTags.includes(`sent:img:${imgName}`)) {
            console.log(`skipping email - it was already sent (${img.name})`);
            continue;
        }

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
                subject: `[ALERTA] Order ${order_number}: Houve um erro no envio do email (${img.name})`,
            });

            return res.status(200).send("Ok");
        }

        // update `nextTags` to add the file sent in order to be skipped next time
        nextTags.push(`sent:img:${imgName}`);

        console.log(`Email sent: ${email.messageId} (${img.name})`);
    }
}

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
    const totalOrderCount = line_items.reduce(
        (acc, line) => acc + line.quantity,
        0
    );
    const hasMissingFiles = countImageUrls(note_attributes) < totalOrderCount;
    let nextTags = [];

    console.log(`Order Update hook for ${order_number}`);

    // add notification and timer (now + 15min) tags when is paid but no file attached
    if (
        !currentTags.includes("notification") &&
        financial_status === "paid" &&
        countImageUrls(note_attributes) === 0
    ) {
        console.log("[start] adding notification timer");
        await addNotificationTimer(order_gid, currentTags);
        console.log("[end] adding notification timer");

        return res.status(200).send("Ok");
    }

    // nothing to process when:
    // - no attachment
    // - not yet paid
    // - order closed
    if (
        countImageUrls(note_attributes) === 0 ||
        financial_status !== "paid" ||
        currentTags.includes("Entregue")
    ) {
        console.log("nothing to process", {
            attachmentsCount: countImageUrls(note_attributes) === 0,
            isPayed: financial_status !== "paid",
            isClosed: currentTags.includes("Entregue"),
        });

        return res.status(200).send("Ok");
    }

    console.log(
        `Sending "${order_number}" email(s) to "${contact_email}" (locale: "${customer_locale}" :: tags: "${tags}" :: hasMissingFiles: "${hasMissingFiles}")"`
    );

    console.log("[start] sending email(s) to client");
    await sendEmailsToClient(
        order_number,
        contact_email,
        note_attributes,
        lang,
        currentTags,
        nextTags
    );
    console.log("[end] sending email(s) to client");

    // if hasMissingFiles update tags, otherwise update tags and fulfill order
    let bulkUpdate, data, errors;
    if (hasMissingFiles && nextTags.length > 0) {
        if (nextTags.sort().join(",") !== currentTags.sort().join(",")) {
            console.log("[start] updating order tags");
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
            console.log("[end] updating order tags");
        } else {
            console.log("skipping tags update, no change");
        }
    } else {
        console.log("[start] getting fulfillment id");
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
                order: { fulfillmentOrders },
            },
        } = await client.request(getOrderOperation, {
            variables: {
                id: order_gid,
            },
        });
        const { id: fulfillmentOrderId } = fulfillmentOrders.nodes[0] ?? {};
        console.log("[end] getting fulfillment id");
        console.log(
            `FulfillmentOrder: "${fulfillmentOrderId}" for ID: "${order_gid}"`
        );

        // remove notification and timer tags as the order is now processed
        const filteredTags = currentTags.filter(
            (tag) =>
                !tag.startsWith("timer:") &&
                !tag.startsWith("sent:img:") &&
                !["notification", "notified"].includes(tag)
        );
        nextTags = [...filteredTags, "Entregue"];
        console.log(
            `Computed next tags: ${nextTags} (original: ${currentTags})`
        );

        console.log("[start] updating order tags and fulfillment");
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
        console.log("[end] updating order tags and fulfillment");
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
        return res.status(500).send("Error");
    }

    res.status(200).send("Ok");
};

export const config = {
    api: {
        bodyParser: false,
    },
};
