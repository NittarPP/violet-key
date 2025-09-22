require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg'); // Use Pool for concurrency
const express = require('express');
const crypto = require('crypto');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING;
const PORT = process.env.PORT || 5000;

// -------------------- POSTGRES DB --------------------
const db = new Pool({
    connectionString: PG_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS Violet_SQL (
            id SERIAL PRIMARY KEY,
            discord_user VARCHAR(50) NOT NULL UNIQUE,
            key VARCHAR(100) NOT NULL UNIQUE,
            hwid VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log("Database ready!");
}
initDB().catch(console.error);

// -------------------- HELPERS --------------------
function generateKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    for (let i = 0; i < 32; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
    return `Violet-Hub-${key}`;
}

async function getOrCreateKey(discordUserId) {
    // Check if user already has a key
    const existing = await db.query('SELECT key FROM Violet_SQL WHERE discord_user=$1', [discordUserId]);
    if (existing.rowCount > 0) return existing.rows[0].key;

    // Generate unique key
    let key;
    let exists = { rowCount: 1 };
    while (exists.rowCount > 0) {
        key = generateKey();
        exists = await db.query('SELECT key FROM Violet_SQL WHERE key=$1', [key]);
    }

    // Insert only once
    await db.query('INSERT INTO Violet_SQL (discord_user, key) VALUES ($1, $2) ON CONFLICT (discord_user) DO NOTHING', [discordUserId, key]);
    return key;
}

async function notifyUserRegistration(discordUserId, hwid) {
    try {
        const user = await bot.users.fetch(discordUserId);
        await user.send(`✅ Your key is now registered!\nHWID: ${hwid}`);
    } catch (err) {
        console.error('Failed to DM user:', err);
    }
}

// -------------------- EXPRESS SERVER --------------------
const app = express();
app.use(express.json());

app.post('/register', async (req, res) => {
    const { key, hwid } = req.body;
    if (!key || !hwid)
        return res.status(400).json({ status: 'error', message: 'Missing key or HWID' });

    const result = await db.query('SELECT * FROM Violet_SQL WHERE key=$1', [key]);
    if (result.rowCount === 0)
        return res.status(404).json({ status: 'error', message: 'Key not found' });

    const record = result.rows[0];

    if (record.hwid) {
        if (record.hwid !== hwid) {
            console.log(`[SECURITY] HWID mismatch for key ${key}`);
            return res.status(403).json({ status: 'error', message: 'HWID mismatch! Kick the player.' });
        } else {
            return res.json({ status: 'success', message: 'HWID already registered.' });
        }
    }

    // Update HWID and notify user
    await db.query('UPDATE Violet_SQL SET hwid=$1 WHERE key=$2', [hwid, key]);
    console.log(`[REGISTERED] Key ${key} registered by HWID: ${hwid}`);

    // Notify user via Discord
    if (record.discord_user) {
        notifyUserRegistration(record.discord_user, hwid);
    }

    res.json({ status: 'success', message: 'HWID registered!' });
});

app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

// -------------------- DISCORD BOT --------------------
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once('ready', async () => {
    console.log('Bot is online!');

    const commands = [
        new SlashCommandBuilder()
            .setName('getkey')
            .setDescription('Generate a unique Violet-Hub key (private)'),
        new SlashCommandBuilder()
            .setName('keymaker')
            .setDescription('Create a public button for users to get keys')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(bot.user.id), { body: commands });
    console.log('Slash commands registered!');
});

// -------------------- DISCORD INTERACTIONS --------------------
bot.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'getkey') {
            const key = await getOrCreateKey(interaction.user.id);
            const embed = new EmbedBuilder()
                .setTitle('Your Violet-Hub Key')
                .setDescription(`Here is your key for the player script:`)
                .addFields({ name: 'Key', value: `\`${key}\`` })
                .setColor('Random');
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } else if (interaction.commandName === 'keymaker') {
            const button = new ButtonBuilder()
                .setCustomId('public_key_button')
                .setLabel('Click to get a key!')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(button);

            const embed = new EmbedBuilder()
                .setTitle('Violet-Hub Key Generator')
                .setDescription('Click the button below to receive your unique key. The key will be sent **privately** to you.')
                .setColor('Random');

            await interaction.reply({ embeds: [embed], components: [row] });
        }
    } else if (interaction.isButton()) {
        if (interaction.customId === 'public_key_button') {
            const key = await getOrCreateKey(interaction.user.id);

            try {
                await interaction.user.send(`✅ Here is your Violet-Hub key:\n\`${key}\``);
                await interaction.reply({ content: '✅ Check your DMs for the key!', ephemeral: true });
            } catch (err) {
                console.error('Failed to DM user:', err);
                await interaction.reply({ content: '❌ Could not send DM. Please make sure DMs are enabled.', ephemeral: true });
            }
        }
    }
});

setInterval(async () => {
  try {
    const oldRows = await db.query(`
      SELECT id, discord_user, key 
      FROM Violet_SQL
      WHERE created_at < NOW() - INTERVAL '1 day';
    `);

    for (const row of oldRows.rows) {
      try {
        if (row.discord_user) {
          const user = await bot.users.fetch(row.discord_user);
          await user.send(`⚠️ Your Violet-Hub key (\`${row.key}\`) was deleted because it was older than 1 day.`);
        }
      } catch (err) {
        console.error(`Failed to DM user ${row.discord_user}:`, err);
      }

      await db.query('DELETE FROM Violet_SQL WHERE id=$1', [row.id]);
      console.log(`Deleted key ${row.key} for user ${row.discord_user}`);
    }

  } catch (err) {
    console.error('Error in auto-delete loop:', err);
  }
}, 1000);

bot.login(DISCORD_TOKEN);

