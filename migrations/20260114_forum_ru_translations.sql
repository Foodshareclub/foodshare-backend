-- Migration: Add Russian translations for forum keys
-- This migration adds Russian translations for forum-related keys

DO $$
DECLARE
  forum_ru_keys jsonb := '{
    "forum": {
      "add_comment_placeholder": "Добавить комментарий...",
      "add_image": "Добавить изображение",
      "best_answer": "Лучший ответ",
      "check_back_later": "Загляните позже за новыми обсуждениями",
      "comments": "Комментарии",
      "comments_count": "{count} комментариев",
      "comments_section": "Комментарии ({count})",
      "content": "Содержание",
      "content_min_length": "Содержание должно быть не менее 20 символов",
      "content_placeholder": "Поделитесь своими мыслями...",
      "create_post": "Создать пост",
      "discussion": "Обсуждение",
      "edit_comment": "Редактировать комментарий",
      "edited": "(изменено)",
      "edited_indicator_notice": "Ваш комментарий будет отмечен как изменённый",
      "empty": {
        "title": "Пока нет постов",
        "description": "Будьте первым, кто начнёт обсуждение!"
      },
      "error": {
        "load_title": "Не удалось загрузить",
        "post_comment_failed": "Не удалось опубликовать комментарий. Попробуйте снова.",
        "post_reply_failed": "Не удалось опубликовать ответ. Попробуйте снова.",
        "unable_to_load": "Не удалось загрузить посты форума",
        "update_comment_failed": "Не удалось обновить комментарий. Попробуйте снова."
      },
      "filters": {
        "all_types": "Все типы",
        "notifications": "Уведомления",
        "notifications_subtitle": "Получать уведомления об ответах",
        "options": "Параметры фильтра",
        "post_type": "Тип поста",
        "questions_only": "Только вопросы",
        "questions_only_subtitle": "Показывать только вопросы",
        "reset_message": "Все фильтры будут сброшены",
        "reset_title": "Сбросить фильтры?",
        "reset_to_defaults": "Сбросить настройки",
        "saved_posts": "Сохранённые посты",
        "saved_posts_subtitle": "Показывать только сохранённые",
        "sort_by": "Сортировать по",
        "title": "Фильтры",
        "unanswered_only": "Без ответов",
        "unanswered_only_subtitle": "Показывать посты без ответов",
        "your_content": "Ваш контент"
      },
      "filters_settings": "Фильтры и настройки",
      "following": "Подписки",
      "hot": "Популярное",
      "latest": "Новое",
      "likes": "Нравится",
      "likes_count": "{count} нравится",
      "load_more": "Загрузить ещё",
      "loading": "Загрузка...",
      "locked": "Закрыто",
      "locked_message": "Это обсуждение закрыто для новых комментариев",
      "mark_as_answer": "Отметить как ответ",
      "new_post": "Новый пост",
      "no_comments": "Пока нет комментариев",
      "no_posts": "Посты не найдены",
      "notifications": {
        "title": "Уведомления форума",
        "empty": "Нет уведомлений",
        "mark_all_read": "Отметить все как прочитанные"
      },
      "pinned": "Закреплено",
      "post": {
        "anonymous": "Аноним",
        "by": "от",
        "delete": "Удалить пост",
        "edit": "Редактировать пост",
        "report": "Пожаловаться",
        "save": "Сохранить",
        "saved": "Сохранено",
        "share": "Поделиться",
        "unsave": "Убрать из сохранённых",
        "view": "Просмотреть пост"
      },
      "post_type": {
        "all": "Все",
        "announcement": "Объявление",
        "discussion": "Обсуждение",
        "guide": "Руководство",
        "question": "Вопрос"
      },
      "replies": "Ответы",
      "replies_count": "{count} ответов",
      "reply": "Ответить",
      "reply_placeholder": "Написать ответ...",
      "report": {
        "title": "Пожаловаться на пост",
        "reason": "Причина жалобы",
        "submit": "Отправить жалобу",
        "success": "Жалоба отправлена"
      },
      "search": {
        "placeholder": "Поиск постов...",
        "no_results": "Ничего не найдено",
        "results": "Результаты поиска"
      },
      "section": {
        "pinned": "Закреплённые",
        "trending": "В тренде",
        "recent": "Недавние"
      },
      "sort": {
        "hot": "Популярное",
        "latest": "Новое",
        "oldest": "Старое",
        "top": "Лучшее",
        "trending": "В тренде",
        "unanswered": "Без ответа"
      },
      "submit": "Опубликовать",
      "title": "Форум",
      "title_placeholder": "Заголовок поста",
      "title_required": "Заголовок обязателен",
      "top": "Лучшее",
      "trending": "В тренде",
      "unanswered": "Без ответа",
      "views": "Просмотры",
      "views_count": "{count} просмотров",
      "write_comment": "Написать комментарий..."
    }
  }'::jsonb;
BEGIN
  -- Update Russian translations
  UPDATE translations
  SET
    messages = deep_merge_jsonb(messages, forum_ru_keys),
    version = to_char(now(), 'YYYYMMDDHH24MISS'),
    updated_at = now()
  WHERE locale = 'ru';
  
  RAISE NOTICE 'Updated Russian forum translations';
END $$;
