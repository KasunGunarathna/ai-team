# Project Idea: <Project name>

> Fill this in and paste it into the **Idea** box in AI Team. The PM/BA agent turns it into the PRD, phases and tasks.
> Write what you know. Leave a section as "Not decided" instead of guessing — PM/BA will list it under Open Questions.

## 1. One-line summary
<What it is, for whom, in one sentence.>

## 2. Problem
<What pain exists today? Who has it? How do they handle it now?>

## 3. Users and roles
| Role | What they need to do |
|---|---|
| <Role 1> | <main jobs> |
| <Role 2> | <main jobs> |
| Admin | <manage users, data, settings> |

## 4. MVP features (must have for first release)
1. <Feature> — <one line of expected behavior>
2. <Feature> — ...
3. <Feature> — ...

## 5. Later (not in MVP)
- <Feature for phase 2+>

## 6. Out of scope
- <Things the product will NOT do>

## 7. Key user journeys
1. **<Role>: <goal>** — <step> → <step> → <result>
2. **<Role>: <goal>** — ...

## 8. Business rules
- <e.g. "A request can only be accepted by one mechanic">
- <limits, statuses, pricing rules, approvals>

## 9. Tech preferences
- Frontend: <e.g. Next.js / React / mobile (React Native) / Not decided>
- Backend: <e.g. NestJS / Not decided>
- Database: <e.g. PostgreSQL + Prisma>
- Auth: <email+password / phone OTP / Google / Not decided>
- Hosting: <local only for now / Not decided>
- Existing code: <new project / existing repo — describe>

## 10. Integrations
- <Maps, SMS, email, payments, file storage — or "None for MVP">

## 11. Non-functional needs
- Platforms: <web, mobile web, iOS, Android>
- Languages: <English, ...>
- Security / privacy: <personal data, location, payments>
- Scale for MVP: <e.g. 100 users, 1 city>

## 12. Success criteria for MVP
- <Observable result, e.g. "Customer can request help and see mechanic assigned within the app">

## 13. Open questions I already know about
- <Decision you have not made yet>

---

## Example (filled in)

# Project Idea: FixMyVehicle

## 1. One-line summary
A web platform that connects drivers with a broken-down vehicle to nearby mechanics and repair shops.

## 2. Problem
Drivers who break down do not know which mechanic is nearby and available. They call around and wait without updates.

## 3. Users and roles
| Role | What they need to do |
|---|---|
| Customer | Report a breakdown, share location and vehicle details, track help |
| Mechanic | Set availability, accept/decline requests, update job status |
| Shop | Manage shop profile, its mechanics and services |
| Admin | Manage users, shops, requests, resolve disputes |

## 4. MVP features
1. Sign up / log in for all four roles — role-based access.
2. Customer creates a breakdown request — location (lat/lng or address), vehicle, problem description.
3. Mechanic sees nearby open requests and accepts one — only one mechanic per request.
4. Request status flow — OPEN → ACCEPTED → ON_THE_WAY → IN_PROGRESS → COMPLETED / CANCELLED.
5. Customer sees live status of their request.
6. Admin list and search of users and requests.

## 5. Later
- Payments, ratings and reviews, push/SMS notifications, live map tracking, mobile apps.

## 6. Out of scope
- Towing logistics, insurance claims, spare-parts marketplace.

## 7. Key user journeys
1. **Customer: get help** — log in → "I broke down" → enter location, vehicle, problem → submit → see "Mechanic assigned" → status updates → completed.
2. **Mechanic: take a job** — log in → set available → see nearby requests → accept → update status until completed.

## 8. Business rules
- A request can be accepted by only one mechanic; second accept must fail.
- Only the assigned mechanic can change job status; customer can cancel only while OPEN or ACCEPTED.
- Mechanic marked unavailable does not see new requests.

## 9. Tech preferences
- Frontend: Next.js (one app, role-based areas)
- Backend: NestJS
- Database: PostgreSQL + Prisma
- Auth: email + password for MVP
- Hosting: local only for now
- Existing code: new project

## 10. Integrations
- None for MVP (enter location manually; maps later).

## 11. Non-functional needs
- Platforms: responsive web (mobile browser first)
- Languages: English
- Security / privacy: customer location and phone are personal data — visible only to assigned mechanic and admin.
- Scale for MVP: one city, ~100 users.

## 12. Success criteria for MVP
- A customer can create a request, a mechanic can accept it, and both see the status change to COMPLETED — covered by an E2E test.

## 13. Open questions
- Target country/city? Payment provider? SMS provider? Shop vs independent mechanic commission rules?
