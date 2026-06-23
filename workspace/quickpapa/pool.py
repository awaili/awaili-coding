"""
SQLite connection pool for the QUICKPAPA backend.

SQLite is single-writer, but Flask serves requests on multiple threads, so we
keep a small pool of connections guarded by a queue. Each connection is opened
once, reused across requests, and configured for safe concurrent access:
  - check_same_thread=False  (so a connection can be used off its creating thread)
  - WAL journal mode           (allows concurrent readers + one writer)
  - busy_timeout               (writers wait instead of raising "database is locked")
"""

import os
import sqlite3
import threading
import queue
import contextlib


class SQLitePool:
    def __init__(self, db_path, size=8, init_sql=None):
        self.db_path = db_path
        self.size = max(1, size)
        self._pool = queue.Queue(maxsize=self.size)
        self._lock = threading.Lock()
        self._created = 0
        self._init_sql = init_sql
        # Pre-warm a couple of connections so the first requests are fast.
        for _ in range(min(2, self.size)):
            self._pool.put(self._new_conn())

    def _new_conn(self):
        with self._lock:
            self._created += 1
        conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA busy_timeout=30000;")
        if self._init_sql:
            try:
                conn.executescript(self._init_sql)
            except sqlite3.OperationalError:
                pass  # schema already exists
        return conn

    @contextlib.contextmanager
    def get(self):
        """Borrow a connection. Commits on success, rolls back on error."""
        try:
            conn = self._pool.get_nowait()
        except queue.Empty:
            conn = self._new_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            try:
                self._pool.put_nowait(conn)
            except queue.Full:
                # Pool is full (we created one on demand); just close it.
                conn.close()

    def query(self, sql, params=()):
        """Run a SELECT and return a list of Row dicts."""
        with self.get() as conn:
            cur = conn.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    def query_one(self, sql, params=()):
        with self.get() as conn:
            cur = conn.execute(sql, params)
            r = cur.fetchone()
            return dict(r) if r else None

    def execute(self, sql, params=()):
        """Run an INSERT/UPDATE/DELETE. Returns lastrowid."""
        with self.get() as conn:
            cur = conn.execute(sql, params)
            return cur.lastrowid

    def executemany(self, sql, seq):
        with self.get() as conn:
            conn.executemany(sql, seq)

    def close_all(self):
        while True:
            try:
                conn = self._pool.get_nowait()
                conn.close()
            except queue.Empty:
                break
        with self._lock:
            self._created = 0