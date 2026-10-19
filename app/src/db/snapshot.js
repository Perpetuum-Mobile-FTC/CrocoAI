// Consistent copy of an open SQLite DB. VACUUM INTO, not a file copy: in WAL mode recent writes
// (even the whole schema) can live only in the -wal file (found 2026-10-02: copies had no tables).
function snapshot(db, dest) {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

module.exports = { snapshot };
