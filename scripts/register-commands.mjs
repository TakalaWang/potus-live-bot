const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN');
  process.exit(1);
}

const commands = [
  {
    type: 1,
    name: 'subscribe',
    description: 'Subscribe a channel to White House live notifications and post-stream reports',
    default_member_permissions: '32',
    contexts: [0],
    options: [
      {
        type: 7,
        name: 'channel',
        description: 'Channel that will receive notifications and reports',
        required: true,
        channel_types: [0, 5],
      },
    ],
  },
  {
    type: 1,
    name: 'unsubscribe',
    description: 'Unsubscribe this server from notifications',
    default_member_permissions: '32',
    contexts: [0],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(commands),
});
if (res.ok) {
  console.log(res.status, 'commands registered');
} else {
  console.error(res.status, 'command registration failed');
}
process.exit(res.ok ? 0 : 1);
