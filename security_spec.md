# Firebase Security Specification

## Data Invariants
- A `File` must have a unique `file_id`.
- `announcements` are unique by `title` and `category`.
- `likes`, `favorites`, and `reports` are unique per user per media item.
- `delivery` records must have a `delete_at` in the future relative to `delivered_at`.

## The "Dirty Dozen" Payloads
1. **Unauthorized File Injection**: Anonymous user tries to create a file record.
2. **File Modification**: Authenticated user tries to edit a file record (e.g., changing `poster_url`).
3. **User Impersonation**: User A tries to update User B's profile.
4. **Ban Self-Removal**: User tries to set `is_banned` to `false` on their own profile.
5. **Config Tampering**: Authenticated user tries to change bot `config`.
6. **Delivery Snooping**: User A tries to read User B's `deliveries`.
7. **Report Spamming**: User sends a report with a huge `title` string.
8. **Invalid Timestamp**: Creating a file with a `added_at` in the past/future (not server time).
9. **Role Escalation**: Attempting to set an `isAdmin` field (if any).
10. **Delivery Deletion**: User tries to delete their own delivery record to prevent auto-delete logic (if bot relies on it).
11. **Negative Request Count**: Setting `request_count` to -1.
12. **Shadow Field Injection**: Adding `is_admin: true` to a user profile payload during creation.

## Test Runner
(Placeholder for `firestore.rules.test.ts` logic - implementation follows rules generation)
