-- FTS5 full-text search over questions.
-- PLAN.md §6.3. Powers dedupe layer 2 (§13.4) and admin question search (§9.4).
--
-- HAND-WRITTEN, not drizzle-generated: drizzle-kit cannot model FTS5 virtual
-- tables or triggers. It is registered in migrations/meta/_journal.json as
-- idx 1 so drizzle-kit's next `generate` emits 0002 rather than colliding here.
--
-- Content is trigger-maintained rather than using an external-content table:
-- our primary keys are TEXT, and a standalone table avoids coupling to rowid.
--
-- `porter` gives English stemming so "created"/"create" collide — which is
-- exactly what duplicate hunting wants. If Malayalam (or any non-English)
-- content becomes a requirement, drop `porter` and keep `unicode61`.

CREATE VIRTUAL TABLE `questions_fts` USING fts5(
  question_id UNINDEXED,
  stem,
  explanation,
  topic,
  tags,
  tokenize = 'porter unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `questions_fts_ai` AFTER INSERT ON `questions` BEGIN
  INSERT INTO `questions_fts`(question_id, stem, explanation, topic, tags)
  VALUES (
    new.id,
    new.stem,
    COALESCE(new.explanation, ''),
    COALESCE(new.topic, ''),
    COALESCE(new.tags, '')
  );
END;--> statement-breakpoint
CREATE TRIGGER `questions_fts_ad` AFTER DELETE ON `questions` BEGIN
  DELETE FROM `questions_fts` WHERE question_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER `questions_fts_au` AFTER UPDATE ON `questions` BEGIN
  DELETE FROM `questions_fts` WHERE question_id = old.id;
  INSERT INTO `questions_fts`(question_id, stem, explanation, topic, tags)
  VALUES (
    new.id,
    new.stem,
    COALESCE(new.explanation, ''),
    COALESCE(new.topic, ''),
    COALESCE(new.tags, '')
  );
END;--> statement-breakpoint
