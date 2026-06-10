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
    description: 'Subscribe this channel to White House live notifications and post-stream reports',
    default_member_permissions: '32',
    contexts: [0],
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
console.log(res.status, res.ok ? 'commands registered' : await res.text());
process.exit(res.ok ? 0 : 1);
