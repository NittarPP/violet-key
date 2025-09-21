require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { Client: PGClient } = require('pg');
const express = require('express');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING;
const PORT = process.env.PORT || 5000;

// -------------------- POSTGRES DB --------------------
const db = new PGClient({
    connectionString: PG_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    await db.connect();
    await db.query(`
        CREATE TABLE IF NOT EXISTS Violet_SQL (
            id SERIAL PRIMARY KEY,
            discord_user VARCHAR(50) NOT NULL,
            key VARCHAR(100) NOT NULL UNIQUE,
            uuid VARCHAR(100),
            hwid VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log("Database ready!");
}
initDB().catch(console.error);

// -------------------- EXPRESS SERVER --------------------
const app = express();
app.use(express.json());

app.post('/register', async (req, res) => {
    const { key, uuid, hwid } = req.body;
    if (!key || !uuid || !hwid)
        return res.status(400).json({ status: 'error', message: 'Missing key, uuid' });

    const result = await db.query('SELECT * FROM Violet_SQL WHERE key=$1', [key]);
    if (result.rowCount === 0)
        return res.status(404).json({ status: 'error', message: 'Key not found' });

    const record = result.rows[0];

    if (record.uuid) {
        if (record.uuid !== uuid) {
            console.log(`[SECURITY] UUID mismatch for key ${key}`);
            return res.status(403).json({ status: 'error', message: 'UUID mismatch! Kick the player.' });
        }
    }

    await db.query('UPDATE Violet_SQL SET uuid=$1, hwid=$2 WHERE key=$3', [uuid, hwid, key]);
    console.log(`[REGISTERED] Key ${key} registered by UUID: ${uuid}, HWID: ${hwid}`);
    res.json({ status: 'success', message: 'UUID registered!' });
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

// -------------------- HELPERS --------------------
function generateKey() {
    let key = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `Violet-Hub-${key}`;
}

async function getOrCreateKey(discordUserId) {
    const existing = await db.query('SELECT key FROM Violet_SQL WHERE discord_user=$1', [discordUserId]);
    if (existing.rowCount > 0) return existing.rows[0].key;

    while (true) {
        const key = generateKey();
        const exists = await db.query('SELECT key FROM Violet_SQL WHERE key=$1', [key]);
        if (exists.rowCount === 0) {
            await db.query('INSERT INTO Violet_SQL (discord_user, key) VALUES ($1, $2)', [discordUserId, key]);
            return key;
        }
    }
}

// Wait for registration and DM user
async function waitForRegistration(key, discordUserId) {
    while (true) {
        const res = await db.query('SELECT uuid, hwid FROM Violet_SQL WHERE key=$1', [key]);
        if (res.rows[0] && res.rows[0].uuid && res.rows[0].hwid) {
            try {
                const user = await bot.users.fetch(discordUserId);
                await user.send(`✅ Your key is now registered!\nUUID: ${res.rows[0].uuid}\nHWID: ${res.rows[0].hwid}`);
            } catch (err) {
                console.error('Failed to DM user:', err);
            }
            return res.rows[0];
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

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

            waitForRegistration(key, interaction.user.id);
        }

        else if (interaction.commandName === 'keymaker') {
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
    }

    else if (interaction.isButton()) {
        if (interaction.customId === 'public_key_button') {
            const key = await getOrCreateKey(interaction.user.id);

            try {
                await interaction.user.send(`✅ Here is your Violet-Hub key:\n\`${key}\``);
                await interaction.reply({ content: '✅ Check your DMs for the key!', ephemeral: true });

                waitForRegistration(key, interaction.user.id);
            } catch (err) {
                console.error('Failed to DM user:', err);
                await interaction.reply({ content: '❌ Could not send DM. Please make sure DMs are enabled.', ephemeral: true });
            }
        }
    }
});

bot.login(DISCORD_TOKEN);
