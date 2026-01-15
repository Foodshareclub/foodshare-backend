-- Fix critical Russian (ru) translations for common namespace
-- These are the most frequently used UI strings in the iOS app

UPDATE translations
SET messages = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        messages::jsonb,
                        '{common,save}', '"Сохранить"'
                      ),
                      '{common,cancel}', '"Отмена"'
                    ),
                    '{common,delete}', '"Удалить"'
                  ),
                  '{common,close}', '"Закрыть"'
                ),
                '{common,back}', '"Назад"'
              ),
              '{common,next}', '"Далее"'
            ),
            '{common,done}', '"Готово"'
          ),
          '{common,retry}', '"Повторить"'
        ),
        '{common,ok}', '"ОК"'
      ),
      '{common,yes}', '"Да"'
    ),
    '{common,no}', '"Нет"'
  ),
  '{common,loading}', '"Загрузка..."'
),
version = to_char(now(), 'YYYYMMDDHH24MISS'),
updated_at = now()
WHERE locale = 'ru';
