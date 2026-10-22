// Расширения Express, которые добавляет приложение.
//
// `req.account` — данные меню аккаунта (собираются в middleware сессий),
// `req.session` — сессия с пользователем, токеном формы и согласием на
// аналитику. Без этого объявления проверка типов считала бы их чужими
// полями и ругалась на каждое обращение.

import 'express';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      account?: {
        nickname?: string;
        unread?: number;
        csrf?: string;
      } | null;
      session?: Session & {
        user?: {
          id: number;
          nickname: string;
          roles?: string[];
          locale?: string;
          theme?: string;
        };
        csrf?: string;
        analyticsConsent?: boolean;
        analyticsAnonId?: string;
        analyticsToken?: string;
      };
    }
  }
}

export {};
