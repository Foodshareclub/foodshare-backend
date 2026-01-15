-- Migration: Comprehensive Russian translations for all major UI elements
-- This adds Russian translations for common, feed, profile, search, settings, and other key namespaces

DO $$
DECLARE
  ru_translations jsonb := '{
    "common": {
      "faq": "ЧаВо",
      "new": "Новое",
      "off": "Выкл",
      "you": "Вы",
      "copy": "Копировать",
      "done": "Готово",
      "edit": "Редактировать",
      "name": "Имя",
      "next": "Далее",
      "open": "Открыть",
      "read": "Прочитано",
      "save": "Сохранить",
      "send": "Отправить",
      "skip": "Пропустить",
      "about": "О приложении",
      "apply": "Применить",
      "block": "Заблокировать",
      "clear": "Очистить",
      "close": "Закрыть",
      "items": "Элементы",
      "later": "Позже",
      "reply": "Ответить",
      "reset": "Сбросить",
      "retry": "Повторить",
      "share": "Поделиться",
      "title": "Заголовок",
      "today": "Сегодня",
      "action": {
        "reset": "Сбросить",
        "retry": "Повторить",
        "cancel": "Отмена",
        "try_again": "Попробовать снова"
      },
      "active": "Активно",
      "cancel": "Отмена",
      "copied": "Скопировано!",
      "delete": "Удалить",
      "enable": "Включить",
      "export": "Экспорт",
      "filter": "Фильтр",
      "got_it": "Понятно",
      "locked": "Заблокировано",
      "period": "Период",
      "remove": "Удалить",
      "report": "Пожаловаться",
      "saving": "Сохранение...",
      "search": "Поиск",
      "status": {
        "loading_more": "Загрузка..."
      },
      "submit": "Отправить",
      "confirm": "Подтвердить",
      "earlier": "Ранее",
      "filters": "Фильтры",
      "loading": "Загрузка...",
      "message": "Сообщение",
      "pending": "Ожидание",
      "refresh": "Обновить",
      "see_all": "Показать все",
      "sort_by": "Сортировать",
      "success": "Успешно",
      "unknown": "Неизвестно",
      "app_name": "Foodshare",
      "complete": "Завершено",
      "continue": "Продолжить",
      "location": "Местоположение",
      "optional": "Необязательно",
      "progress": "Прогресс",
      "required": "Обязательно",
      "selected": "Выбрано",
      "settings": "Настройки",
      "unlocked": "Разблокировано",
      "untitled": "Без названия",
      "view_all": "Показать все",
      "anonymous": "Аноним",
      "clear_all": "Очистить все",
      "copy_link": "Копировать ссылку",
      "load_more": "Загрузить ещё",
      "show_less": "Показать меньше",
      "show_more": "Показать больше",
      "try_again": "Попробовать снова",
      "contact_us": "Связаться с нами",
      "learn_more": "Узнать больше",
      "no_results": "Ничего не найдено",
      "share_food": "Поделиться едой",
      "submitting": "Отправка...",
      "get_started": "Начать",
      "information": "Информация",
      "maybe_later": "Может позже",
      "unsubscribe": "Отписаться",
      "clear_search": "Очистить поиск",
      "loading_more": "Загрузка...",
      "not_selected": "Не выбрано",
      "nothing_here": "Пока ничего нет",
      "save_changes": "Сохранить изменения",
      "notifications": "Уведомления",
      "tap_to_unlock": "Нажмите для разблокировки",
      "error_occurred": "Произошла ошибка",
      "privacy_policy": "Политика конфиденциальности",
      "tap_to_dismiss": "Нажмите для закрытия",
      "something_wrong": "Что-то пошло не так",
      "terms_of_service": "Условия использования",
      "copy_to_clipboard": "Копировать в буфер",
      "something_went_wrong": "Что-то пошло не так",
      "help": "Помощь"
    },
    "feed": {
      "trending": "В тренде",
      "share_now": "Поделиться сейчас",
      "no_listings": "Нет объявлений о еде поблизости",
      "loading_more": "Загрузка...",
      "loading_title": "Поиск еды рядом с вами",
      "pull_to_refresh": "Потяните для обновления",
      "no_more_items": "Больше нет элементов",
      "refresh_failed": "Не удалось обновить",
      "empty_title": "Нет еды поблизости",
      "empty_description": "Попробуйте увеличить радиус поиска или загляните позже",
      "help_reduce_waste": "Помогите сократить пищевые отходы",
      "filter_by_category": "Фильтр по категории",
      "sort_by_distance": "По расстоянию",
      "sort_by_newest": "По новизне",
      "sort_by_expiring": "По сроку годности"
    },
    "search": {
      "tab": {
        "food": "Еда",
        "category": "Категория",
        "location": "Место"
      },
      "clear": "Очистить",
      "title": {
        "food": "Какую еду вы ищете?",
        "_title": "Поиск",
        "category": "Выберите категорию",
        "location": "Где вы ищете?"
      },
      "filters": "Фильтры",
      "popular": "Популярное",
      "sort_by": "Сортировать",
      "distance": "Расстояние",
      "show_map": "Показать карту",
      "all_types": "Все типы",
      "clear_all": "Очистить все",
      "listening": "Слушаю...",
      "post_type": "Тип поста",
      "searching": "Поиск...",
      "categories": "Категории",
      "no_results": "Ничего не найдено",
      "show_posts": "Показать посты",
      "placeholder": {
        "food": "Поиск фруктов, овощей, выпечки...",
        "_title": "Поиск еды рядом...",
        "default": "Что вы ищете?",
        "category": "Выберите категорию...",
        "location": "Введите город, район или адрес..."
      },
      "distance_max": "Макс. расстояние",
      "distance_min": "Мин. расстояние",
      "voice_prompt": "Скажите, что вы ищете",
      "results_count": "Найдено: {count}",
      "adjust_filters": "Попробуйте другой запрос или измените фильтры",
      "saved_searches": "Сохранённые поиски",
      "recent_searches": "Недавние поиски",
      "search_for_food": "Поиск еды",
      "find_surplus_food": "Найдите излишки еды рядом"
    },
    "profile": {
      "level": "Уровень {level}",
      "share": "Поделиться профилем",
      "stats": {
        "rating": "Рейтинг",
        "shared": "Отдано",
        "received": "Получено"
      },
      "title": "Профиль",
      "badges": "Значки",
      "earned": "Заработано",
      "impact": {
        "meals": "Порций",
        "share": "Поделиться влиянием",
        "title": "Ваш вклад",
        "co2_saved": "Сэкономлено CO2",
        "water_saved": "Сэкономлено воды",
        "meals_shared": "Порций передано"
      },
      "points": "Баллы",
      "loading": "Загрузка профиля...",
      "reviews": "Отзывы",
      "activity": "Активность",
      "no_photo": "Нет фото",
      "settings": "Настройки",
      "sign_out": "Выйти",
      "next_step": "Следующий шаг",
      "collection": "Коллекция",
      "new_member": "Новичок",
      "no_reviews": "Пока нет отзывов",
      "export_data": "Экспорт данных",
      "information": "Информация",
      "my_listings": "Мои объявления",
      "xp_progress": "Прогресс XP",
      "change_photo": "Изменить фото",
      "default_name": "Аноним",
      "edit_profile": "Редактировать профиль",
      "help_support": "Помощь и поддержка",
      "badges_earned": "Значков получено",
      "blocked_users": "Заблокированные",
      "notifications": "Уведомления",
      "share_profile": "Поделиться профилем",
      "to_next_level": "{points} до следующего уровня",
      "delete_account": "Удалить аккаунт",
      "invite_friends": "Пригласить друзей",
      "community_forum": "Форум сообщества",
      "featured_badges": "Избранные значки",
      "see_all_reviews": "Все отзывы",
      "account_settings": "Настройки аккаунта",
      "complete_profile": "Заполните профиль",
      "sign_out_confirm": "Вы уверены, что хотите выйти?",
      "email_preferences": "Настройки email",
      "view_full_profile": "Полный профиль"
    },
    "settings": {
      "title": "Настройки",
      "_title": "Настройки",
      "account": "Аккаунт",
      "privacy_policy": "Политика конфиденциальности",
      "terms_of_service": "Условия использования",
      "sign_out": "Выйти",
      "sign_out_confirm": "Вы уверены, что хотите выйти?",
      "theme": "Тема",
      "language": {
        "change": "Изменить язык",
        "search": "Поиск языка",
        "available": "Доступные языки",
        "use_system": "Использовать системный"
      },
      "notifications": {
        "push": "Push-уведомления",
        "email": "Email-уведомления",
        "sound": "Звук",
        "title": "Уведомления",
        "_title": "Уведомления",
        "messages": "Сообщения",
        "community": "Сообщество",
        "push_desc": "Получать уведомления в реальном времени",
        "vibration": "Вибрация",
        "arrangements": "Договорённости",
        "new_listings": "Новые объявления"
      },
      "privacy": {
        "_title": "Конфиденциальность",
        "screen": "Защита экрана",
        "clipboard": "Безопасность буфера",
        "app_privacy": "Конфиденциальность приложения",
        "screen_desc": "Скрывать содержимое в фоне",
        "session_timeout": "Тайм-аут сессии"
      },
      "security": {
        "score": "Оценка безопасности",
        "_title": "Безопасность",
        "features": "Функции безопасности"
      },
      "section": {
        "about": "О приложении",
        "preferences": "Настройки",
        "support": "Поддержка"
      },
      "version": "Версия",
      "delete_account": "Удалить аккаунт",
      "change_password": "Изменить пароль",
      "edit_profile": "Редактировать профиль"
    },
    "challenges": {
      "view": {
        "deck": "Карточки",
        "list": "Список",
        "leaderboard": "Лидеры"
      },
      "empty": {
        "title": "Нет вызовов",
        "joined": "Вы ещё не присоединились к вызовам",
        "available": "Сейчас нет доступных вызовов"
      },
      "score": "Счёт: {score}",
      "filter": {
        "all": "Все",
        "joined": "Участвую",
        "completed": "Завершённые"
      },
      "loading": "Загрузка вызовов...",
      "no_leaders": "Пока нет лидеров",
      "leaderboard": "Таблица лидеров",
      "participants": "Участников: {count}"
    },
    "messages": {
      "chat": "Чат",
      "typing": "печатает...",
      "empty_description": "Начните разговор, запросив еду"
    },
    "messaging": {
      "view": "Просмотр",
      "archive": "Архив",
      "filter_by": "Фильтр по",
      "mark_read": "Прочитано",
      "unarchive": "Из архива",
      "post_number": "Пост #{id}",
      "explore_food": "Найти еду",
      "type_message": "Введите сообщение",
      "search_placeholder": "Поиск бесед...",
      "delete_conversation": "Удалить беседу"
    },
    "notifications": {
      "push": "Push-уведомления",
      "empty": "Нет уведомлений",
      "title": "Уведомления",
      "unread": "Непрочитанные",
      "loading": "Загрузка уведомлений...",
      "replies": "Ответы",
      "mentions": "Упоминания",
      "reactions": "Реакции",
      "clear_read": "Очистить прочитанные",
      "preferences": "Настройки уведомлений",
      "mark_as_read": "Отметить прочитанным",
      "mark_all_read": "Отметить все прочитанными",
      "no_notifications": "Нет уведомлений",
      "no_notifications_desc": "Всё просмотрено! Новые уведомления появятся здесь."
    },
    "activity": {
      "title": "Активность",
      "empty_desc": "Активность вашего сообщества появится здесь.",
      "empty_title": "Нет недавней активности"
    },
    "reviews": {
      "sort": {
        "newest": "Новые",
        "oldest": "Старые",
        "lowest_rating": "Низкий рейтинг",
        "highest_rating": "Высокий рейтинг"
      },
      "title": "Отзывы",
      "helpful": "Полезно",
      "no_reviews": "Пока нет отзывов",
      "all_reviews": "Все отзывы",
      "write_review": "Написать отзыв",
      "report_review": "Пожаловаться",
      "submit_review": "Отправить отзыв",
      "your_feedback": "Ваш отзыв",
      "how_was_experience": "Как прошёл опыт?"
    },
    "listing": {
      "type": {
        "food": "Поделиться едой",
        "item": "Поделиться вещью",
        "lend": "Одолжить",
        "vegan": "Веганское",
        "wanted": "Нужно",
        "zerowaste": "Без отходов"
      },
      "action": {
        "edit_listing": "Редактировать",
        "request_item": "Запросить",
        "sign_in_request": "Войдите, чтобы запросить"
      },
      "detail": {
        "type": "Тип",
        "hours": "Часы",
        "views": "Просмотров: {count}",
        "posted": "Опубликовано",
        "available": "Доступно"
      },
      "sharer": "Даритель",
      "status": {
        "arranged": "Договорено",
        "inactive": "Неактивно",
        "available": "Доступно"
      },
      "details": "Подробности",
      "reviews": "Отзывы",
      "arranged": "Договорено",
      "expiring": "Истекает",
      "no_images": "Нет изображений",
      "directions": "Маршрут",
      "edit_title": "Редактировать объявление",
      "report_item": "Пожаловаться",
      "create_title": "Создать объявление",
      "leave_review": "Оставить отзыв",
      "send_message": "Отправить сообщение",
      "contact_sharer": "Связаться с дарителем",
      "quick_messages": "Быстрые сообщения",
      "pickup_location": "Место получения"
    },
    "create": {
      "type": {
        "food": "Поделиться едой",
        "forum": "Пост на форуме",
        "vegan": "Веганское",
        "borrow": "Одолжить",
        "things": "Поделиться вещами",
        "wanted": "Нужно",
        "zerowaste": "Без отходов"
      },
      "title": "Поделиться едой",
      "photos": "Фото",
      "details": "Детали",
      "section": {
        "community": "Сообщество",
        "lifestyle": "Образ жизни",
        "share_items": "Поделиться"
      },
      "category": "Категория",
      "subtitle": "Поделитесь излишками еды с сообществом",
      "add_photo": "Добавить фото",
      "basic_info": "Основная информация",
      "sign_in_title": "Войдите, чтобы поделиться едой",
      "sign_in_button": "Войти",
      "browse_as_guest": "Просмотр как гость",
      "pickup_location": "Место получения",
      "sign_in_subtitle": "Присоединяйтесь к сообществу, чтобы делиться едой",
      "use_current_location": "Использовать текущее местоположение"
    },
    "onboarding": {
      "terms": "Условия",
      "privacy": "Конфиденциальность",
      "tagline": "Делитесь едой, сокращайте отходы, помогайте сообществу",
      "welcome": "Добро пожаловать в Foodshare",
      "discover": "Найдите еду рядом с вами",
      "legal_info": "Важная правовая информация",
      "agree_terms": "Я согласен с Условиями использования и Политикой конфиденциальности",
      "confirm_age": "Я подтверждаю, что мне 18 лет или больше",
      "agree_continue": "Согласен и продолжить",
      "important_info": "Важная информация",
      "privacy_policy": "Политика конфиденциальности",
      "terms_of_service": "Условия использования"
    },
    "support": {
      "title": "Поддержать Foodshare",
      "_title": "Поддержка",
      "buy_coffee": "Угостите нас кофе",
      "donate_now": "Пожертвовать",
      "coffee_saves_meal": "Каждый кофе помогает спасти порцию еды"
    },
    "help": {
      "title": "Помощь",
      "message": "Сообщение",
      "section": {
        "using_app": "Использование приложения",
        "food_safety": "Безопасность еды",
        "account_privacy": "Аккаунт и конфиденциальность"
      }
    },
    "status": {
      "saving": "Сохранение...",
      "loading": "Загрузка...",
      "syncing": "Синхронизация...",
      "searching": "Поиск...",
      "submitting": "Отправка...",
      "loading_post": "Загрузка поста...",
      "loading_listing": "Загрузка объявления...",
      "loading_profile": "Загрузка профиля...",
      "loading_challenge": "Загрузка вызова...",
      "loading_challenges": "Загрузка вызовов...",
      "loading_leaderboard": "Загрузка лидеров..."
    },
    "errors": {
      "title": "Ошибка",
      "unknown": "Произошла неизвестная ошибка",
      "not_found": {
        "post": "Пост не найден",
        "title": "Не найдено",
        "listing": "Объявление не найдено",
        "profile": "Профиль не найден"
      },
      "no_results": {
        "title": "Ничего не найдено",
        "description": "Попробуйте другой запрос или измените фильтры"
      }
    },
    "biometric": {
      "type": {
        "face_id": "Face ID",
        "optic_id": "Optic ID",
        "touch_id": "Touch ID"
      },
      "locked": "Заблокировано",
      "use_passcode": "Использовать код",
      "use_password": "Использовать пароль",
      "auth_required": "Требуется аутентификация",
      "tap_to_unlock": "Нажмите для разблокировки",
      "verify_identity": "Подтвердите личность для продолжения"
    },
    "filter": {
      "sort_by": "Сортировать",
      "view_grid": "Сетка",
      "view_list": "Список",
      "view_mode": "Режим просмотра",
      "search_radius": "Радиус поиска",
      "feed_statistics": "Статистика ленты",
      "reset_to_defaults": "Сбросить настройки"
    },
    "arrangement": {
      "status": {
        "arranged": "Договорено",
        "available": "Доступно",
        "completed": "Завершено"
      },
      "confirm": {
        "cancel_title": "Отменить договорённость?",
        "cancel_button": "Отменить договорённость",
        "request_title": "Запросить этот товар?",
        "complete_title": "Отметить как завершённое?",
        "request_button": "Запросить"
      },
      "request_pickup": "Запросить получение"
    },
    "ForgotPassword": {
      "title": "Забыли пароль?",
      "description": "Не волнуйтесь! Введите email, и мы отправим ссылку для сброса.",
      "back_to_login": "Вернуться к входу",
      "send_reset_link": "Отправить ссылку",
      "check_email_title": "Проверьте почту",
      "remember_password": "Вспомнили пароль?"
    },
    "guest": {
      "banner": {
        "title": "Просмотр как гость",
        "action": "Регистрация",
        "subtitle": "Зарегистрируйтесь, чтобы разблокировать все функции"
      },
      "prompt": {
        "title": "Войдите для {feature}",
        "action": "Войти",
        "message": "Создайте бесплатный аккаунт для доступа к этой функции",
        "secondary": "Продолжить просмотр"
      }
    },
    "invite": {
      "hero": {
        "title": "Пригласить друзей",
        "description": "Поделитесь Foodshare с друзьями и семьёй"
      },
      "email": {
        "title": "Пригласить по email",
        "placeholder": "Введите email адреса",
        "send_button": "Отправить приглашения"
      },
      "share": {
        "title": "Пригласить друзей",
        "button": "Поделиться"
      },
      "title": "Пригласить друзей"
    },
    "report": {
      "submit": "Отправить жалобу",
      "submitted": "Жалоба отправлена",
      "submitting": "Отправка жалобы...",
      "report_title": "Сообщить о проблеме",
      "select_reason": "Выберите причину жалобы",
      "help_understand": "Помогите нам понять проблему",
      "already_reported": "Уже отправлено",
      "additional_details": "Дополнительные детали"
    },
    "feedback": {
      "title": "Отправить отзыв",
      "message": "Сообщение",
      "subject": "Тема",
      "success_message": "Отзыв успешно отправлен!"
    },
    "badges": {
      "share": {
        "title": "Поделиться достижением",
        "_title": "Поделиться",
        "nav_title": "Поделиться значком"
      },
      "detail": {
        "title": "Детали значка",
        "earned": "Получено",
        "locked": "Заблокировано",
        "points": "{points} баллов",
        "progress": "Прогресс"
      },
      "awesome": "Отлично!",
      "summary": {
        "earned": "Получено",
        "points": "Баллы",
        "complete": "Завершено",
        "collection": "Коллекция"
      },
      "featured": "Избранные значки",
      "unlocked": "Разблокировано"
    },
    "leaderboard": {
      "period": {
        "all_time": "За всё время",
        "this_week": "На этой неделе",
        "this_month": "В этом месяце"
      },
      "category": {
        "reviews": "Отзывы",
        "items_shared": "Отдано",
        "total_impact": "Общий вклад",
        "items_received": "Получено"
      }
    },
    "Maintenance": {
      "title": "Техническое обслуживание",
      "refresh": "Обновить статус",
      "description": "Проводятся плановые работы. Пожалуйста, зайдите позже."
    },
    "ChallengeReveal": {
      "tip": "Совет: используйте стрелки для навигации",
      "skip": "Пропустить",
      "title": "Откройте вызовы",
      "accept": "Принять",
      "shuffle": "Перемешать",
      "subtitle": "Свайп вправо — принять, влево — пропустить",
      "allCaughtUp": "Всё просмотрено!",
      "shuffleAgain": "Перемешать снова"
    }
  }'::jsonb;
BEGIN
  -- Update Russian translations
  UPDATE translations
  SET
    messages = deep_merge_jsonb(messages, ru_translations),
    version = to_char(now(), 'YYYYMMDDHH24MISS'),
    updated_at = now()
  WHERE locale = 'ru';
  
  RAISE NOTICE 'Updated comprehensive Russian translations';
END $$;
