const axios = require('axios')
const uuid = require('uuid')
const channelAdapters = require('../../channel-adapters')

const assert = (condition, e) => {

    if (!condition) {
        throw new Error(e)
    }
}

const extractTokenFromHeaders = (headers) => {
    const { authorization } = headers
    if (!authorization) {
        return null
    }
    const parts = authorization.split(' ')
    if (parts.length !== 2) {
        return null
    }
    if (parts[0] !== 'Bearer') {
        return null
    }
    // if (globalId.isOfType('key', parts[1]) === false) return null
    return parts[1]
}

module.exports = ctx => async ({ from, subject, body, template, channel: channelType, to = [], cc = [], bcc = [], payload, attachments = [] }) => {

    const token = extractTokenFromHeaders(ctx.req.headers)

    assert(token, 'token not specified')

    const [application] = await ctx.db.query('SELECT * FROM applications WHERE secret = ?', [
        token
    ])

    assert(application, 'application not found')

    const [channel] = await ctx.db.query('SELECT `channels`.* FROM `channels` JOIN `applications_channels` ON `channels`.`id` = `applications_channels`.`channelId` WHERE `applications_channels`.`applicationId` = ? AND `channels`.`type` = ? LIMIT 1', [
        application.id,
        channelType
    ])

    assert(channel, 'channel not found')

    const channelAdapterFactory = channelAdapters[channel.adapter]

    assert(channelAdapterFactory, 'channel adapter not found')

    const channelAdapter = channelAdapterFactory({
        ...ctx,
        channel: {
            ...channel,
            config: JSON.parse(channel.config)
        }
    })

    if (template) {

        const response = await axios.request({
            method: 'post',
            url: process.env.DEFAULT_TEMPLATE_RENDER_API_URL,
            data: {
                template,
                payload
            }
        })

        if (response.data.status === "error") {
            throw new Error(`could not render template: ${response.data.message}`)
        }

        body = response.data.data.body

        if (!subject) {
            subject = response.data.data.subject
        }
    }

    subject = ctx.testMode ? `[TEST MODE] ${subject}` : subject

    const recipients = [
        ...to.map(({ name, email }) => ({ name, email, type: 'to' })),
        ...cc.map(({ name, email }) => ({ name, email, type: 'cc' })),
        ...bcc.map(({ name, email }) => ({ name, email, type: 'bcc' })),
    ]

    const contextId = uuid.v4()

    const messages = await Promise.all(
        recipients.map(async recipient => {

            const message = {
                id: uuid.v4(),
                testMode: ctx.testMode,
                applicationId: application.id,
                channel: channel.id,
                subject,
                contextId,
                fromName: from ? from.name : null,
                attention: recipient.name,
                to: recipient.email,
                template,
                payload,
                body,
                muted: false,
                confirmed: false,
                sent: false,
                openCount: 0,
                clickCount: 0,
                bounced: 0,
                createdAt: new Date()
            }

            const data = {
                ...message
            }

            data.payload = JSON.stringify(data.payload, null, 2)

            await ctx.db.query('INSERT INTO messages SET ?', data)

            return message
        })
    )

    await channelAdapter.send({
        id: contextId,
        testMode: ctx.testMode,
        from,
        to,
        cc,
        bcc,
        subject,
        body,
        attachments
    })

    return {
        messages
    }
}