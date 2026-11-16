const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_DATA = {
  version: 1,
  prefix: '%',
  authorizedUsers: [],
  presence: null,
  guilds: {},
};

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await this.writeUnlocked(clone(DEFAULT_DATA));
    }
  }

  async read() {
    await this.queue;
    return clone(await this.readUnlocked());
  }

  async update(mutator) {
    const run = async () => {
      const data = await this.readUnlocked();
      const result = await mutator(data);
      await this.writeUnlocked(data);
      return result;
    };

    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async readUnlocked() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return normalizeData(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return clone(DEFAULT_DATA);
      }

      throw error;
    }
  }

  async writeUnlocked(data) {
    const tmpPath = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tmpPath, `${JSON.stringify(normalizeData(data), null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}

function normalizeData(data) {
  const normalized = {
    ...clone(DEFAULT_DATA),
    ...(data && typeof data === 'object' ? data : {}),
  };

  if (!Array.isArray(normalized.authorizedUsers)) {
    normalized.authorizedUsers = [];
  }

  normalized.authorizedUsers = uniqueStrings(normalized.authorizedUsers);
  normalized.prefix = typeof normalized.prefix === 'string' && normalized.prefix.trim()
    ? normalized.prefix.trim()
    : DEFAULT_DATA.prefix;

  if (!normalized.guilds || typeof normalized.guilds !== 'object') {
    normalized.guilds = {};
  }

  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set(values.map(String).filter(Boolean))];
}

module.exports = {
  JsonStore,
};
