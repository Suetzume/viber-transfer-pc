-- Спецификация Manifest.db резервной копии iOS (iTunes / libimobiledevice)
-- Источник: открытые спецификации conorarmstrong/iphone_extract_backup, datatags/mount-ios-backup

CREATE TABLE IF NOT EXISTS Files (
    fileID TEXT PRIMARY KEY,    -- SHA-1(domain + "-" + relativePath)
    domain TEXT NOT NULL,      -- Например: AppDomainGroup-group.viber
    relativePath TEXT NOT NULL,-- Например: database/Chat.data
    flags INTEGER DEFAULT 1,   -- Флаги прав доступа/типа файла
    file BLOB                  -- Бинарный Plist с метаданными (размер, mtime, inode)
);

CREATE INDEX IF NOT EXISTS idx_files_domain_path ON Files (domain, relativePath);
