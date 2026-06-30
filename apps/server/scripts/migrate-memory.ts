import { SQLiteMemoryStorage } from '../src/memory/storage.js';

const storage = new SQLiteMemoryStorage();
storage.close();
console.log('memory migration ok');
