-- Референсная схема базы данных Android Viber (viber_messages.db)
-- Источник: открытые спецификации mbv06/ViberDBViewer, Belkasoft Forensics

CREATE TABLE IF NOT EXISTS conversations (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    icon_id INTEGER DEFAULT 0,
    date INTEGER,
    snippet TEXT,
    unread_events_count INTEGER DEFAULT 0,
    flags INTEGER DEFAULT 0,
    conversation_type INTEGER DEFAULT 0,
    creator_id TEXT,
    share_location INTEGER DEFAULT 0,
    token INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participants (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER,
    participant_type INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (conversation_id) REFERENCES conversations(_id)
);

CREATE TABLE IF NOT EXISTS participants_info (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL,
    viber_name TEXT,
    display_name TEXT,
    contact_name TEXT,
    photo_id INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    participant_id INTEGER NOT NULL,
    body TEXT,
    msg_date INTEGER NOT NULL, -- Unix Epoch timestamp в миллисекундах
    type INTEGER DEFAULT 0,    -- 0: Входящее, 1: Исходящее, 2: Системное
    status INTEGER DEFAULT 0,  -- 0: Отправлено, 1: Доставлено, 2: Прочитано
    unread INTEGER DEFAULT 0,  -- 0: Прочитано, 1: Не прочитано
    order_key INTEGER,
    extra_mime INTEGER DEFAULT 0,
    extra_duration INTEGER DEFAULT 0,
    media_path TEXT,
    description TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages (msg_date);
