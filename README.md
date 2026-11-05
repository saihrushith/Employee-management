# Aarviko Workforce

Employee attendance, live screen monitoring and payroll for two accounts (one manager, one employee).

- Frontend: static files (`index.html`, `app.js`), no build step. Host anywhere (Hostinger static, Vercel, Netlify).
- Backend: Supabase project `aarviko-employee-management` (Auth, Postgres with RLS, Realtime, Storage).
- Live screen: WebRTC peer to peer, signalled over a private Realtime channel only the two users can join.

## Rules implemented
- Shift 10:00 IST, on time until 10:10. Later login: 1/4 of that day's pay is cut.
- No login on a working day: that day's pay is not given. Sundays and manager-marked festivals are paid holidays.
- Day rate = monthly salary / days in month (salary 8000).
- 5 minutes without activity starts an idle break; it ends at the next activity.
- Screen share must be "Entire Screen" (window/tab shares are rejected).

## Notes
- Use Chrome or Edge on the employee machine. The tab must stay open.
- Employee screen activity is detected by pixel change on the shared screen plus input in the app tab; tune `diffPct` in `app.js`.
- If the two networks cannot connect, add a TURN server to `iceServers` in `app.js`.
