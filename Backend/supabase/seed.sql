-- Demo events from the current website (dates shifted to the future so booking works).
-- Run once in the SQL editor AFTER the two migrations. organizer_id is null => chats go to the first admin.

insert into public.events (organization_name, title, title_ur, description, category, city, venue, event_date, start_time, end_time, is_free, status) values
('LUMS Computing Society', 'LUMS Tech Fusion 2026',       'LUMS ٹیک فیوژن 2026',        'Two days of hackathons, robotics, AI workshops and startup pitches.', 'Tech Fest',   'Lahore',    'LUMS, Lahore',          current_date + 14, '09:00', '18:00', true,  'approved'),
('NUST Sports Society',   'NUST Inter-University Games',   'NUST انٹر یونیورسٹی گیمز',    'Inter-university sports competition.',                                 'Sports Gala', 'Islamabad', 'NUST, Islamabad',       current_date + 21, '09:00', '17:00', false, 'approved'),
('IBA Business Club',     'IBA Business Case Summit',      'IBA بزنس کیس سمٹ',           'Case competition and industry talks.',                                 'Academic',    'Karachi',   'IBA, Karachi',          current_date + 28, '10:00', '16:00', true,  'approved'),
('FAST Cultural Society', 'FAST Mehfil-e-Rang',            'FAST محفلِ رنگ',             'An evening of music, poetry and culture.',                             'Cultural',    'Lahore',    'FAST-NUCES, Lahore',    current_date + 35, '17:00', '22:00', false, 'approved'),
('COMSATS CS Society',    'COMSATS AI Hackathon',          'COMSATS AI ہیکاتھون',        '24-hour AI hackathon.',                                                'Tech Fest',   'Islamabad', 'COMSATS, Islamabad',    current_date + 42, '09:00', '18:00', true,  'approved'),
('UoK Entrepreneurship Cell','UoK Entrepreneurship Expo',  'UoK انٹرپرینیورشپ ایکسپو',   'Startup expo and investor meetups.',                                   'Business',    'Karachi',   'University of Karachi', current_date + 49, '10:00', '17:00', true,  'approved'),
('PU Sports Dept',        'PU Athletics Championship',     'PU ایتھلیٹکس چیمپیئن شپ',    'Annual athletics championship.',                                       'Sports Gala', 'Lahore',    'Punjab University, Lahore', current_date + 56, '09:00', '17:00', false, 'approved'),
('GIKI Research Office',  'GIKI Research Symposium',       'GIKI ریسرچ سمپوزیم',         'Student and faculty research presentations.',                          'Academic',    'Islamabad', 'GIKI, Topi',            current_date + 63, '09:00', '16:00', true,  'approved');

-- paid events get a ticket tier (free events got "Free Entry" automatically via trigger)
insert into public.ticket_tiers (event_id, name, description, price_pkr)
select id, 'Regular Pass', 'Standard access', 500 from public.events where title = 'NUST Inter-University Games';
insert into public.ticket_tiers (event_id, name, description, price_pkr)
select id, 'Regular Pass', 'Standard access', 300 from public.events where title = 'FAST Mehfil-e-Rang';
insert into public.ticket_tiers (event_id, name, description, price_pkr)
select id, 'Regular Pass', 'Standard access', 200 from public.events where title = 'PU Athletics Championship';
insert into public.ticket_tiers (event_id, name, description, price_pkr)
select id, 'Premium Pass', 'Front row seat + certificate', 700 from public.events where title = 'NUST Inter-University Games';

-- Make yourself admin AFTER you sign up on the website (replace the email):
-- update public.profiles set role = 'admin' where email = 'your-email@example.com';
