require('dotenv').config();

const path = require('node:path');
const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
} = require('discord.js');
const { JsonStore } = require('./storage');

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_IDS = csv(process.env.OWNER_IDS);
const TIMEZONE = process.env.TIMEZONE || 'Asia/Riyadh';
const DATA_PATH = path.join(__dirname, '..', 'data', 'db.json');
const MESSAGE_HISTORY_LIMIT = 250;
const LOG_MESSAGE_LIMIT = 50;
const PAGE_SIZE = 25;

const DEFAULT_DURATIONS = [
  { id: '5m', label: '5 دقائق', ms: 5 * 60 * 1000 },
  { id: '30m', label: '30 دقيقة', ms: 30 * 60 * 1000 },
  { id: '1h', label: 'ساعة', ms: 60 * 60 * 1000 },
];

const ACTIVITY_TYPES = {
  playing: { label: 'يلعب', type: ActivityType.Playing },
  watching: { label: 'يشاهد', type: ActivityType.Watching },
  listening: { label: 'يستمع', type: ActivityType.Listening },
  competing: { label: 'ينافس', type: ActivityType.Competing },
};

const store = new JsonStore(DATA_PATH);
const appOwnerIds = new Set();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async () => {
  await store.init();
  await loadApplicationOwners();
  await applySavedPresence();

  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Settings command: ${await currentPrefix()}settings or ${await currentPrefix()}اعدادات`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    const data = await store.read();
    if (isSettingsCommand(message.content, data.prefix)) {
      if (!(await canUseSettings(message.author.id))) {
        await message.reply({
          content: 'اعدادات البوت خاصة بالمالك والمصرحين فقط.',
          allowedMentions: { repliedUser: false },
        });
        return;
      }

      await message.reply(settingsPanel(data.prefix));
      return;
    }

    await processWatchedMessage(message);
  } catch (error) {
    console.error('Message handler failed:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.guild && interaction.customId?.startsWith('settings:')) {
      await safeReply(interaction, { content: 'الاعدادات تعمل داخل السيرفر فقط.', ephemeral: true });
      return;
    }

    if (!interaction.customId || !isSettingsInteraction(interaction.customId)) return;

    if (!(await canUseSettings(interaction.user.id))) {
      await safeReply(interaction, {
        content: 'ما عندك تصريح لاستخدام اعدادات البوت.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (error) {
    console.error('Interaction handler failed:', error);
    await safeReply(interaction, {
      content: 'صار خطأ غير متوقع. شيك كونسول البوت للتفاصيل.',
      ephemeral: true,
    });
  }
});

async function handleButton(interaction) {
  const [namespace, action, rawPage] = interaction.customId.split(':');
  const page = Number.parseInt(rawPage || '0', 10) || 0;

  if (namespace !== 'settings') return;

  await handleSettingsAction(interaction, action, page);
}

async function handleSettingsAction(interaction, action, page = 0) {
  if (action === 'prefix') {
    await interaction.showModal(textModal('modal:prefix', 'تغيير برفكس البوت', [
      shortInput('value', 'البرفكس الجديد', 'مثال: !', 1, 10, true),
    ]));
    return;
  }

  if (action === 'auth-toggle') {
    await promptForMention(interaction, {
      title: 'اضافة / ازالة مصرح',
      prompt: 'ارسل منشن الشخص أو اكتب ID حقه خلال 60 ثانية. اذا كان موجود ينشال، واذا مو موجود ينضاف.',
      onUser: async (user) => {
        const result = await store.update((data) => toggleValue(data.authorizedUsers, user.id));
        return result.added
          ? `تم اضافة <@${user.id}> لقائمة المصرحين.`
          : `تم ازالة <@${user.id}> من قائمة المصرحين.`;
      },
    });
    return;
  }

  if (action === 'auth-list') {
    const data = await store.read();
    await interaction.reply({
      embeds: [listEmbed('المصرحين للاعدادات', data.authorizedUsers, 'ما فيه مصرحين مضافين حالياً.')],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === 'bot-name') {
    await interaction.showModal(textModal('modal:bot-name', 'تغيير اسم البوت', [
      shortInput('value', 'اسم البوت الجديد', 'Prison Guard', 2, 32, true),
    ]));
    return;
  }

  if (action === 'bot-avatar') {
    await promptForImage(interaction, {
      prompt: 'ارسل صورة الافتار الجديدة خلال 60 ثانية.',
      onImage: async (dataUri) => {
        await client.user.setAvatar(dataUri);
        return 'تم تغيير افتار البوت.';
      },
    });
    return;
  }

  if (action === 'bot-banner') {
    await promptForImage(interaction, {
      prompt: 'ارسل صورة البنر الجديدة خلال 60 ثانية.',
      onImage: async (dataUri) => {
        await client.rest.patch(Routes.user(), { body: { banner: dataUri } });
        return 'تم تغيير بنر البوت.';
      },
    });
    return;
  }

  if (action === 'status') {
    await interaction.reply({
      content: 'اختر نوع الحالة:',
      components: [statusTypeRow()],
      ephemeral: true,
    });
    return;
  }

  if (action === 'watch-toggle') {
    await promptForMention(interaction, {
      title: 'مراقبة / ازالة سجين',
      prompt: 'ارسل منشن العضو أو اكتب ID حقه خلال 60 ثانية. اذا كان موجود ينشال، واذا مو موجود ينضاف.',
      onUser: async (user) => {
        const result = await store.update((data) => {
          const guild = ensureGuild(data, interaction.guildId);
          return toggleValue(guild.watchedUsers, user.id);
        });

        return result.added
          ? `تمت اضافة <@${user.id}> لقائمة السجناء المراقبين.`
          : `تمت ازالة <@${user.id}> من قائمة السجناء المراقبين.`;
      },
    });
    return;
  }

  if (action === 'watch-list') {
    const guild = await readGuild(interaction.guildId);
    await interaction.reply({
      embeds: [listEmbed('السجناء المراقبون', guild.watchedUsers, 'ما فيه سجناء مراقبون حالياً.')],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (action === 'words-add') {
    await interaction.showModal(textModal('modal:words-add', 'اضافة الكلمات الممنوعة', [
      paragraphInput('value', 'اكتب كل كلمة بسطر أو افصل بينها بفواصل', 'كلمة1\nكلمة2', 1, 2000, true),
    ]));
    return;
  }

  if (action === 'words-list') {
    await interaction.reply(await wordsManager(interaction.guildId, page));
    return;
  }

  if (action === 'phrases-add') {
    await interaction.showModal(textModal('modal:phrases-add', 'الجمل المراد ارسالها', [
      paragraphInput('value', 'كل جملة بسطر', 'هدّ اللعب شوي.\nراك مراقب.', 1, 4000, true),
    ]));
    return;
  }

  if (action === 'phrases-list') {
    await interaction.reply(await phrasesManager(interaction.guildId, page));
    return;
  }

  if (action === 'punishment') {
    await interaction.reply(await punishmentManager(interaction.guildId));
    return;
  }

  if (action === 'punish-add') {
    await interaction.showModal(textModal('modal:punish-add', 'اضافة مدة عقابية', [
      shortInput('label', 'اسم الخيار', '10 دقائق', 1, 40, true),
      shortInput('duration', 'المدة', '10m / 2h / 1d', 1, 20, true),
    ]));
    return;
  }

  if (action === 'log') {
    const guild = await readGuild(interaction.guildId);
    if (!guild.watchedUsers.length) {
      await interaction.reply({ content: 'ما فيه سجناء مراقبون حالياً.', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: 'اختر العضو لعرض سجله:',
      components: [await userSelectRow(interaction.guild, 'settings:log-user', guild.watchedUsers)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
}

async function handleSelect(interaction) {
  const [namespace, action, rawPage] = interaction.customId.split(':');
  const page = Number.parseInt(rawPage || '0', 10) || 0;

  if (namespace !== 'settings') return;

  if (action === 'main-menu') {
    const [selectedAction, selectedRawPage] = interaction.values[0].split(':');
    const selectedPage = Number.parseInt(selectedRawPage || '0', 10) || 0;
    await handleSettingsAction(interaction, selectedAction, selectedPage);
    return;
  }

  if (action === 'status-type') {
    const type = interaction.values[0];
    await interaction.showModal(textModal(`modal:status:${type}`, 'نص حالة البوت', [
      shortInput('value', 'نص الحالة', 'يراقب السجناء', 1, 128, true),
    ]));
    return;
  }

  if (action === 'words-delete') {
    const indexes = interaction.values.map((value) => Number.parseInt(value, 10)).filter(Number.isInteger);
    const deleted = await store.update((data) => {
      const guild = ensureGuild(data, interaction.guildId);
      return removeIndexes(guild.forbiddenWords, indexes);
    });

    await interaction.update(asUpdate(await wordsManager(
      interaction.guildId,
      page,
      `تم حذف: ${deleted.join('، ') || 'لا شيء'}`
    )));
    return;
  }

  if (action === 'phrases-delete') {
    const indexes = interaction.values.map((value) => Number.parseInt(value, 10)).filter(Number.isInteger);
    const deleted = await store.update((data) => {
      const guild = ensureGuild(data, interaction.guildId);
      return removeIndexes(guild.replyPhrases, indexes);
    });

    await interaction.update(asUpdate(await phrasesManager(
      interaction.guildId,
      page,
      `تم حذف ${deleted.length} جملة.`
    )));
    return;
  }

  if (action === 'punish-active') {
    const durationId = interaction.values[0];
    await store.update((data) => {
      const guild = ensureGuild(data, interaction.guildId);
      if (guild.punishmentDurations.some((duration) => duration.id === durationId)) {
        guild.activePunishmentDurationId = durationId;
      }
    });

    await interaction.update(asUpdate(await punishmentManager(interaction.guildId, 'تم تغيير المدة العقابية النشطة.')));
    return;
  }

  if (action === 'punish-delete') {
    const durationId = interaction.values[0];
    const deleted = await store.update((data) => {
      const guild = ensureGuild(data, interaction.guildId);
      if (guild.punishmentDurations.length <= 1) return null;
      const index = guild.punishmentDurations.findIndex((duration) => duration.id === durationId);
      if (index === -1) return null;
      const [removed] = guild.punishmentDurations.splice(index, 1);
      if (guild.activePunishmentDurationId === removed.id) {
        guild.activePunishmentDurationId = guild.punishmentDurations[0]?.id || null;
      }
      return removed;
    });

    await interaction.update(asUpdate(await punishmentManager(
      interaction.guildId,
      deleted ? `تم حذف مدة: ${deleted.label}` : 'لا يمكن حذف آخر مدة عقابية.'
    )));
    return;
  }

  if (action === 'log-user') {
    const userId = interaction.values[0];
    const report = await buildAndMarkMemberLog(interaction.guild, userId);
    await interaction.reply({
      embeds: [report.embed],
      files: [report.attachment],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
}

async function handleModal(interaction) {
  const [namespace, action, extra] = interaction.customId.split(':');
  if (namespace !== 'modal') return;

  if (action === 'prefix') {
    const prefix = interaction.fields.getTextInputValue('value').trim();
    if (/\s/.test(prefix)) {
      await interaction.reply({ content: 'البرفكس ما يقدر يحتوي على مسافات.', ephemeral: true });
      return;
    }

    await store.update((data) => {
      data.prefix = prefix;
    });

    await interaction.reply({
      content: `تم تغيير البرفكس. الاوامر الآن: \`${prefix}settings\` أو \`${prefix}اعدادات\`.`,
      ephemeral: true,
    });
    return;
  }

  if (action === 'bot-name') {
    const name = interaction.fields.getTextInputValue('value').trim();
    await client.user.setUsername(name);
    await interaction.reply({ content: `تم تغيير اسم البوت إلى: ${name}`, ephemeral: true });
    return;
  }

  if (action === 'words-add') {
    const words = splitEntries(interaction.fields.getTextInputValue('value'));
    const added = await store.update((data) => {
      const guild = ensureGuild(data, interaction.guildId);
      return addUnique(guild.forbiddenWords, words, true);
    });

    await interaction.reply({
      content: added.length ? `تمت اضافة ${added.length} كلمة ممنوعة.` : 'كل الكلمات موجودة مسبقاً.',
      ephemeral: true,
    });
    return;
  }

  if (action === 'phrases-add') {
    const phrases = splitLines(interaction.fields.getTextInputValue('value'));
    const added = await store.update((data) => {
      const guild = ensureGuild(data, interaction.guildId);
      return addUnique(guild.replyPhrases, phrases, false);
    });

    await interaction.reply({
      content: added.length ? `تمت اضافة ${added.length} جملة.` : 'كل الجمل موجودة مسبقاً.',
      ephemeral: true,
    });
    return;
  }

  if (action === 'punish-add') {
    const label = interaction.fields.getTextInputValue('label').trim();
    const rawDuration = interaction.fields.getTextInputValue('duration').trim();
    const ms = parseDuration(rawDuration);

    if (!ms) {
      await interaction.reply({
        content: 'صيغة المدة غير صحيحة. أمثلة مقبولة: `10m`، `2h`، `1d`، `30د`.',
        ephemeral: true,
      });
      return;
    }

    const duration = {
      id: `d${Date.now().toString(36)}`,
      label,
      ms,
    };

    await store.update((data) => {
      const guild = ensureGuild(data, interaction.guildId);
      guild.punishmentDurations.push(duration);
      guild.activePunishmentDurationId = duration.id;
    });

    await interaction.reply({
      content: `تمت اضافة مدة عقابية وتفعيلها: ${label} (${formatDuration(ms)}).`,
      ephemeral: true,
    });
    return;
  }

  if (action === 'status') {
    const activity = ACTIVITY_TYPES[extra];
    const text = interaction.fields.getTextInputValue('value').trim();

    if (!activity) {
      await interaction.reply({ content: 'نوع الحالة غير معروف.', ephemeral: true });
      return;
    }

    client.user.setPresence({
      status: 'online',
      activities: [{ name: text, type: activity.type }],
    });

    await store.update((data) => {
      data.presence = { activityType: extra, text };
    });

    await interaction.reply({
      content: `تم ضبط الحالة: ${activity.label} ${text}`,
      ephemeral: true,
    });
  }
}

async function processWatchedMessage(message) {
  const action = await store.update((data) => {
    const guild = ensureGuild(data, message.guildId);
    if (!guild.watchedUsers.includes(message.author.id)) return null;

    const now = Date.now();
    const forbiddenMatches = findForbiddenMatches(message.content, guild.forbiddenWords);
    const messageRecord = {
      id: message.id,
      channelId: message.channelId,
      content: cleanContent(message.content),
      createdAt: now,
      shown: false,
    };

    const messages = guild.recentMessages[message.author.id] || [];
    messages.push(messageRecord);
    guild.recentMessages[message.author.id] = messages.slice(-MESSAGE_HISTORY_LIMIT);

    if (forbiddenMatches.length) {
      const violations = guild.violations[message.author.id] || [];
      for (const match of forbiddenMatches) {
        violations.push({
          id: `${message.id}:${match.word}`,
          word: match.word,
          count: match.count,
          content: cleanContent(message.content),
          channelId: message.channelId,
          messageId: message.id,
          createdAt: now,
          shown: false,
        });
      }
      guild.violations[message.author.id] = violations.slice(-500);
    }

    const counter = guild.messageCounters[message.author.id] || {
      countSinceReply: 0,
      nextAt: randomInt(15, 30),
    };

    counter.countSinceReply += 1;
    let replyPhrase = null;
    if (guild.replyPhrases.length && counter.countSinceReply >= counter.nextAt) {
      replyPhrase = guild.replyPhrases[randomInt(0, guild.replyPhrases.length - 1)];
      counter.countSinceReply = 0;
      counter.nextAt = randomInt(15, 30);
    }
    guild.messageCounters[message.author.id] = counter;

    return {
      forbiddenMatches,
      replyPhrase,
      punishment: forbiddenMatches.length ? activePunishment(guild) : null,
    };
  });

  if (!action) return;

  if (action.forbiddenMatches.length && action.punishment) {
    await applyTimeout(message, action.punishment).catch((error) => {
      console.warn(`Timeout failed for ${message.author.id} in ${message.guildId}:`, error.message);
    });
  }

  if (action.replyPhrase) {
    await message.reply({
      content: action.replyPhrase,
      allowedMentions: { repliedUser: true },
    });
  }
}

async function applyTimeout(message, punishment) {
  const botMember = message.guild.members.me || await message.guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    console.warn(`Missing Moderate Members permission in guild ${message.guildId}`);
    return;
  }

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || !member.moderatable) {
    console.warn(`Cannot timeout member ${message.author.id} in guild ${message.guildId}`);
    return;
  }

  await member.timeout(
    Math.min(punishment.ms, 28 * 24 * 60 * 60 * 1000),
    `Prison monitor forbidden word punishment: ${punishment.label}`
  );
}

async function wordsManager(guildId, page, notice = null) {
  const guild = await readGuild(guildId);
  const totalPages = Math.max(1, Math.ceil(guild.forbiddenWords.length / PAGE_SIZE));
  const safePage = clamp(page, 0, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageItems = guild.forbiddenWords.slice(start, start + PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle('الكلمات الممنوعة')
    .setDescription(pageItems.length
      ? pageItems.map((word, index) => `${start + index + 1}. ${word}`).join('\n')
      : 'ما فيه كلمات ممنوعة حالياً.')
    .setFooter({ text: `صفحة ${safePage + 1}/${totalPages}` });

  if (notice) embed.addFields({ name: 'تحديث', value: notice });

  return {
    embeds: [embed],
    components: pagedDeleteComponents('words-list', 'words-delete', safePage, totalPages, pageItems, start, 'اختر كلمات لحذفها'),
    ephemeral: true,
  };
}

async function phrasesManager(guildId, page, notice = null) {
  const guild = await readGuild(guildId);
  const totalPages = Math.max(1, Math.ceil(guild.replyPhrases.length / PAGE_SIZE));
  const safePage = clamp(page, 0, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageItems = guild.replyPhrases.slice(start, start + PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle('الجمل المضافة')
    .setDescription(pageItems.length
      ? pageItems.map((phrase, index) => `${start + index + 1}. ${truncate(phrase, 120)}`).join('\n')
      : 'ما فيه جمل مضافة حالياً.')
    .setFooter({ text: `صفحة ${safePage + 1}/${totalPages}` });

  if (notice) embed.addFields({ name: 'تحديث', value: notice });

  return {
    embeds: [embed],
    components: pagedDeleteComponents('phrases-list', 'phrases-delete', safePage, totalPages, pageItems, start, 'اختر جمل لحذفها'),
    ephemeral: true,
  };
}

async function punishmentManager(guildId, notice = null) {
  const guild = await readGuild(guildId);
  const active = activePunishment(guild);
  const description = guild.punishmentDurations
    .map((duration) => {
      const mark = duration.id === guild.activePunishmentDurationId ? 'نشطة' : 'غير نشطة';
      return `- ${duration.label}: ${formatDuration(duration.ms)} (${mark})`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle('المدة العقابية')
    .setDescription(description || 'ما فيه مدد عقابية.')
    .addFields({ name: 'المفعلة الآن', value: active ? `${active.label} (${formatDuration(active.ms)})` : 'غير محددة' });

  if (notice) embed.addFields({ name: 'تحديث', value: notice });

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('settings:punish-add')
        .setLabel('اضافة مدة')
        .setStyle(ButtonStyle.Primary)
    ),
  ];

  if (guild.punishmentDurations.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings:punish-active')
        .setPlaceholder('اختيار المدة النشطة')
        .addOptions(guild.punishmentDurations.slice(0, PAGE_SIZE).map((duration) => ({
          label: truncate(duration.label, 90),
          description: formatDuration(duration.ms),
          value: duration.id,
          default: duration.id === guild.activePunishmentDurationId,
        })))
    ));
  }

  if (guild.punishmentDurations.length > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('settings:punish-delete')
        .setPlaceholder('حذف مدة عقابية')
        .addOptions(guild.punishmentDurations.slice(0, PAGE_SIZE).map((duration) => ({
          label: truncate(duration.label, 90),
          description: formatDuration(duration.ms),
          value: duration.id,
        })))
    ));
  }

  return { embeds: [embed], components: rows, ephemeral: true };
}

async function buildAndMarkMemberLog(guild, userId) {
  const user = await client.users.fetch(userId).catch(() => null);
  const result = await store.update((data) => {
    const guildData = ensureGuild(data, guild.id);
    const allViolations = guildData.violations[userId] || [];
    const newViolations = allViolations.filter((entry) => !entry.shown).slice(-LOG_MESSAGE_LIMIT);
    const allMessages = guildData.recentMessages[userId] || [];
    const newMessages = allMessages.filter((entry) => !entry.shown).slice(-LOG_MESSAGE_LIMIT);

    for (const entry of newViolations) entry.shown = true;
    for (const entry of newMessages) entry.shown = true;

    return {
      allViolations: allViolations.map((entry) => ({ ...entry })),
      newViolations: newViolations.map((entry) => ({ ...entry })),
      newMessages: newMessages.map((entry) => ({ ...entry })),
    };
  });

  const status = result.allViolations.length ? 'متلطخ (1)' : 'نظيف (0)';
  const wordCounts = summarizeViolations(result.allViolations);
  const titleName = user ? `${user.tag} (${user.id})` : userId;
  const report = [
    `سجل العضو: ${titleName}`,
    `السيرفر: ${guild.name} (${guild.id})`,
    `الحالة: ${status}`,
    `تاريخ العرض: ${formatDate(Date.now())}`,
    '',
    'ملخص الكلمات الممنوعة:',
    wordCounts.length
      ? wordCounts.map((item) => `- ${item.word}: ${item.count} مرة`).join('\n')
      : '- لا توجد مخالفات.',
    '',
    `المخالفات الجديدة منذ آخر عرض (${result.newViolations.length}):`,
    result.newViolations.length
      ? result.newViolations.map((entry) => formatViolationLine(entry, guild.id)).join('\n')
      : '- لا توجد مخالفات جديدة.',
    '',
    `آخر الرسائل الجديدة غير المعروضة (${result.newMessages.length}/${LOG_MESSAGE_LIMIT}):`,
    result.newMessages.length
      ? result.newMessages.map((entry) => formatMessageLine(entry, guild.id)).join('\n')
      : '- لا توجد رسائل جديدة غير معروضة.',
    '',
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(result.allViolations.length ? 0xb3261e : 0x2e7d32)
    .setTitle('سجل العضو')
    .setDescription([
      `العضو: <@${userId}>`,
      `الحالة: ${status}`,
      `اجمالي المخالفات: ${result.allViolations.reduce((sum, entry) => sum + entry.count, 0)}`,
      `رسائل جديدة في الملف: ${result.newMessages.length}`,
    ].join('\n'));

  const attachment = new AttachmentBuilder(Buffer.from(report, 'utf8'), {
    name: `member-log-${userId}.txt`,
  });

  return { embed, attachment };
}

function settingsPanel(prefix) {
  const embed = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle('اعدادات البوت')
    .setDescription([
      `الاوامر الحالية: \`${prefix}settings\` أو \`${prefix}اعدادات\``,
      'اختر المطلوب من القائمة.'
    ].join('\n'));

  const rows = [
    new ActionRowBuilder().addComponents(
      settingsMenu()
    ),
  ];

  return {
    embeds: [embed],
    components: rows,
    allowedMentions: { parse: [] },
  };
}

function settingsMenu() {
  return new StringSelectMenuBuilder()
    .setCustomId('settings:main-menu')
    .setPlaceholder('اختر اعداد')
    .addOptions([
      menuOption('برفكس البوت', 'prefix', 'تغيير بادئة اوامر البوت'),
      menuOption('اضافة / ازالة مصرح', 'auth-toggle', 'منشن شخص لاضافته أو ازالته'),
      menuOption('عرض المصرحين', 'auth-list', 'عرض من يقدر يستخدم الاعدادات'),
      menuOption('تغيير اسم البوت', 'bot-name', 'تغيير اسم حساب البوت'),
      menuOption('تغيير افتار البوت', 'bot-avatar', 'ارسل صورة الافتار الجديدة'),
      menuOption('تغيير بنر البوت', 'bot-banner', 'ارسل صورة البنر الجديدة'),
      menuOption('حالة البوت', 'status', 'اختيار نوع الحالة ونصها'),
      menuOption('مراقبة / ازالة سجين', 'watch-toggle', 'منشن عضو لاضافته أو ازالته'),
      menuOption('عرض السجناء المراقبون', 'watch-list', 'عرض الاعضاء تحت المراقبة'),
      menuOption('اضافة كلمات ممنوعة', 'words-add', 'اضافة كلمات ممنوعة كسطور أو بفواصل'),
      menuOption('عرض الكلمات الممنوعة', 'words-list:0', 'عرض الكلمات وحذف المختار منها'),
      menuOption('الجمل المراد ارسالها', 'phrases-add', 'اضافة ردود عشوائية'),
      menuOption('عرض الجمل المضافة', 'phrases-list:0', 'عرض الجمل وحذف المختار منها'),
      menuOption('تحديد مدة عقابية', 'punishment', 'اضافة أو اختيار مدة الاسكات'),
      menuOption('عرض سجل العضو', 'log', 'عرض سجل سجين مراقب'),
    ]);
}

function menuOption(label, value, description) {
  return { label, value, description };
}

function textModal(customId, title, inputs) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  modal.addComponents(...inputs.map((input) => new ActionRowBuilder().addComponents(input)));
  return modal;
}

function shortInput(customId, label, placeholder, minLength, maxLength, required) {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setMinLength(minLength)
    .setMaxLength(maxLength)
    .setRequired(required);
}

function paragraphInput(customId, label, placeholder, minLength, maxLength, required) {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(minLength)
    .setMaxLength(maxLength)
    .setRequired(required);
}

function statusTypeRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('settings:status-type')
      .setPlaceholder('نوع الحالة')
      .addOptions(Object.entries(ACTIVITY_TYPES).map(([value, info]) => ({
        label: info.label,
        value,
      })))
  );
}

async function userSelectRow(guild, customId, userIds) {
  const options = [];

  for (const id of userIds.slice(0, PAGE_SIZE)) {
    const member = await guild.members.fetch(id).catch(() => null);
    const user = member?.user || await client.users.fetch(id).catch(() => null);
    options.push({
      label: truncate(member?.displayName || user?.tag || id, 90),
      value: id,
      description: `Discord ID: ${id}`,
    });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('اختر عضو')
      .addOptions(options)
  );
}

function pagedDeleteComponents(listAction, deleteAction, page, totalPages, pageItems, start, placeholder) {
  const rows = [];

  if (pageItems.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`settings:${deleteAction}:${page}`)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(Math.min(pageItems.length, PAGE_SIZE))
        .addOptions(pageItems.map((item, index) => ({
          label: truncate(String(item), 90),
          value: String(start + index),
        })))
    ));
  }

  if (totalPages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`settings:${listAction}:${Math.max(0, page - 1)}`)
        .setLabel('السابق')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`settings:${listAction}:${Math.min(totalPages - 1, page + 1)}`)
        .setLabel('التالي')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    ));
  }

  return rows;
}

async function promptForMention(interaction, options) {
  await interaction.reply({
    content: `${options.title}\n${options.prompt}`,
    ephemeral: true,
  });

  const collected = await interaction.channel.awaitMessages({
    filter: (message) => message.author.id === interaction.user.id,
    max: 1,
    time: 60_000,
  }).catch(() => null);

  const message = collected?.first();
  if (!message) {
    await interaction.followUp({ content: 'انتهى الوقت بدون استلام منشن.', ephemeral: true });
    return;
  }

  const user = await resolveUserFromMessage(message);
  if (!user) {
    await interaction.followUp({ content: 'ما قدرت احدد العضو. ارسل منشن صحيح أو ID.', ephemeral: true });
    return;
  }

  const response = await options.onUser(user);
  await interaction.followUp({
    content: response,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

async function promptForImage(interaction, options) {
  await interaction.reply({ content: options.prompt, ephemeral: true });

  const collected = await interaction.channel.awaitMessages({
    filter: (message) => message.author.id === interaction.user.id && message.attachments.size > 0,
    max: 1,
    time: 60_000,
  }).catch(() => null);

  const message = collected?.first();
  const attachment = message?.attachments.find((file) => isImageAttachment(file));
  if (!attachment) {
    await interaction.followUp({ content: 'ما وصلت صورة صالحة خلال الوقت المحدد.', ephemeral: true });
    return;
  }

  const dataUri = await attachmentToDataUri(attachment);
  const response = await options.onImage(dataUri);
  await interaction.followUp({ content: response, ephemeral: true });
}

async function attachmentToDataUri(attachment) {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status}`);
  }

  const contentType = attachment.contentType || response.headers.get('content-type') || mimeFromName(attachment.name);
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function isImageAttachment(attachment) {
  return attachment.contentType?.startsWith('image/')
    || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || '');
}

function mimeFromName(name = '') {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.gif$/i.test(name)) return 'image/gif';
  if (/\.webp$/i.test(name)) return 'image/webp';
  return 'image/png';
}

async function resolveUserFromMessage(message) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned;

  const id = message.content.match(/\d{17,20}/)?.[0];
  if (!id) return null;

  return client.users.fetch(id).catch(() => null);
}

async function readGuild(guildId) {
  const data = await store.read();
  return ensureGuild(data, guildId);
}

function ensureGuild(data, guildId) {
  const guild = data.guilds[guildId] || {};
  guild.watchedUsers = Array.isArray(guild.watchedUsers) ? uniqueStrings(guild.watchedUsers) : [];
  guild.forbiddenWords = Array.isArray(guild.forbiddenWords) ? uniqueStrings(guild.forbiddenWords) : [];
  guild.replyPhrases = Array.isArray(guild.replyPhrases) ? uniqueStrings(guild.replyPhrases) : [];
  guild.messageCounters = guild.messageCounters && typeof guild.messageCounters === 'object' ? guild.messageCounters : {};
  guild.recentMessages = guild.recentMessages && typeof guild.recentMessages === 'object' ? guild.recentMessages : {};
  guild.violations = guild.violations && typeof guild.violations === 'object' ? guild.violations : {};
  guild.punishmentDurations = Array.isArray(guild.punishmentDurations) && guild.punishmentDurations.length
    ? guild.punishmentDurations
    : DEFAULT_DURATIONS.map((duration) => ({ ...duration }));
  guild.activePunishmentDurationId = guild.activePunishmentDurationId || guild.punishmentDurations[0]?.id || null;
  data.guilds[guildId] = guild;
  return guild;
}

function toggleValue(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) {
    list.splice(index, 1);
    return { added: false };
  }

  list.push(value);
  return { added: true };
}

function addUnique(list, values, caseInsensitive) {
  const existing = new Set(list.map((item) => caseInsensitive ? item.toLowerCase() : item));
  const added = [];

  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (existing.has(key)) continue;
    list.push(value);
    existing.add(key);
    added.push(value);
  }

  return added;
}

function removeIndexes(list, indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => b - a);
  const removed = [];

  for (const index of sorted) {
    if (index >= 0 && index < list.length) {
      removed.unshift(...list.splice(index, 1));
    }
  }

  return removed;
}

function activePunishment(guild) {
  return guild.punishmentDurations.find((duration) => duration.id === guild.activePunishmentDurationId)
    || guild.punishmentDurations[0]
    || null;
}

function findForbiddenMatches(content, words) {
  const lowerContent = content.toLowerCase();
  return words
    .map((word) => ({ word, count: countWholeWordOccurrences(lowerContent, word.toLowerCase()) }))
    .filter((match) => match.count > 0);
}

function countWholeWordOccurrences(haystack, needle) {
  if (!needle) return 0;

  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    if (hasWordBoundaries(haystack, index, needle.length)) {
      count += 1;
    }
    index += needle.length;
  }
  return count;
}

function hasWordBoundaries(text, start, length) {
  const before = start > 0 ? text[start - 1] : '';
  const afterIndex = start + length;
  const after = afterIndex < text.length ? text[afterIndex] : '';

  return !isWordCharacter(before) && !isWordCharacter(after);
}

function isWordCharacter(character) {
  return Boolean(character) && /[\p{L}\p{N}\p{M}_]/u.test(character);
}

function summarizeViolations(violations) {
  const counts = new Map();
  for (const entry of violations) {
    counts.set(entry.word, (counts.get(entry.word) || 0) + entry.count);
  }

  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);
}

function formatViolationLine(entry, guildId) {
  const jumpUrl = `https://discord.com/channels/${guildId}/${entry.channelId}/${entry.messageId}`;
  return `- [${formatDate(entry.createdAt)}] <#${entry.channelId}> | الكلمة: ${entry.word} | العدد: ${entry.count} | الرسالة: ${entry.content} | الرابط: ${jumpUrl}`;
}

function formatMessageLine(entry, guildId) {
  const jumpUrl = `https://discord.com/channels/${guildId}/${entry.channelId}/${entry.id}`;
  return `- [${formatDate(entry.createdAt)}] <#${entry.channelId}> | ${entry.content} | الرابط: ${jumpUrl}`;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('ar-SA', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: TIMEZONE,
  }).format(new Date(timestamp));
}

function parseDuration(input) {
  const match = input.trim().toLowerCase().match(/^(\d+)\s*(s|sec|secs|second|seconds|ث|ثانية|ثواني|m|min|mins|minute|minutes|د|دقيقة|دقائق|h|hr|hrs|hour|hours|س|ساعة|ساعات|d|day|days|ي|يوم|ايام)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = [
    [/^(s|sec|secs|second|seconds|ث|ثانية|ثواني)$/i, 1000],
    [/^(m|min|mins|minute|minutes|د|دقيقة|دقائق)$/i, 60 * 1000],
    [/^(h|hr|hrs|hour|hours|س|ساعة|ساعات)$/i, 60 * 60 * 1000],
    [/^(d|day|days|ي|يوم|ايام)$/i, 24 * 60 * 60 * 1000],
  ];

  const multiplier = multipliers.find(([regex]) => regex.test(unit))?.[1];
  if (!amount || !multiplier) return null;

  const ms = amount * multiplier;
  return ms > 0 && ms <= 28 * 24 * 60 * 60 * 1000 ? ms : null;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} ثانية`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ساعة`;
  const days = Math.round(hours / 24);
  return `${days} يوم`;
}

async function loadApplicationOwners() {
  try {
    const application = await client.application.fetch();
    if (application.owner?.id) {
      appOwnerIds.add(application.owner.id);
    }

    if (application.owner?.members) {
      for (const member of application.owner.members.values()) {
        if (member.user?.id) appOwnerIds.add(member.user.id);
      }
    }
  } catch (error) {
    console.warn('Could not load application owners:', error.message);
  }
}

async function applySavedPresence() {
  const data = await store.read();
  if (!data.presence) return;

  const activity = ACTIVITY_TYPES[data.presence.activityType];
  if (!activity || !data.presence.text) return;

  client.user.setPresence({
    status: 'online',
    activities: [{ name: data.presence.text, type: activity.type }],
  });
}

async function canUseSettings(userId) {
  if (OWNER_IDS.includes(userId) || appOwnerIds.has(userId)) return true;
  const data = await store.read();
  return data.authorizedUsers.includes(userId);
}

async function currentPrefix() {
  const data = await store.read();
  return data.prefix;
}

function isSettingsCommand(content, prefix) {
  const trimmed = content.trim();
  return trimmed === `${prefix}settings` || trimmed === `${prefix}اعدادات`;
}

function isSettingsInteraction(customId) {
  return customId.startsWith('settings:') || customId.startsWith('modal:');
}

function listEmbed(title, ids, emptyText) {
  return new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle(title)
    .setDescription(ids.length ? ids.map((id, index) => `${index + 1}. <@${id}> (${id})`).join('\n') : emptyText);
}

function splitEntries(text) {
  return uniqueStrings(text
    .split(/[\n,،]+/)
    .map((entry) => entry.trim())
    .filter(Boolean));
}

function splitLines(text) {
  return uniqueStrings(text
    .split(/\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean));
}

function csv(value) {
  return uniqueStrings(String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean));
}

function uniqueStrings(values) {
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))];
}

function cleanContent(content) {
  return truncate(content.replace(/\s+/g, ' ').trim() || '[بدون نص]', 700);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asUpdate(payload) {
  const { ephemeral, ...rest } = payload;
  return rest;
}

async function safeReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => null);
  } else {
    await interaction.reply(payload).catch(() => null);
  }
}

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

client.login(TOKEN);
