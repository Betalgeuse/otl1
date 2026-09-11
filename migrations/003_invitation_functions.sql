BEGIN;

CREATE FUNCTION otl.member_status(p_workspace text, p_user text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE
  v_member otl.memberships%ROWTYPE;
  v_month date := date_trunc('month', current_timestamp AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
  SELECT * INTO v_member FROM otl.memberships
    WHERE workspace_id = p_workspace AND user_id = p_user;
  RETURN jsonb_build_object(
    'admitted', v_member.user_id IS NOT NULL,
    'founder', v_member.user_id IS NOT NULL AND v_member.invited_by IS NULL,
    'remaining', CASE WHEN v_member.user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM otl.invites WHERE workspace_id = p_workspace
        AND inviter_id = p_user AND issued_month = v_month
    ) THEN 1 ELSE 0 END,
    'month', to_char(v_month, 'YYYY-MM'), 'invitedBy', v_member.invited_by);
END;
$$;

CREATE FUNCTION otl.issue_invite(
  p_workspace text, p_actor text, p_email_hash text, p_token_hash text, p_month text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE
  v_month date := date_trunc('month', current_timestamp AT TIME ZONE 'Asia/Seoul')::date;
  v_expires timestamptz := (v_month + interval '1 month') AT TIME ZONE 'Asia/Seoul';
  v_invite otl.invites%ROWTYPE;
  v_inserted boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM otl.memberships
    WHERE workspace_id = p_workspace AND user_id = p_actor) THEN
    RAISE EXCEPTION 'Membership required' USING ERRCODE = '42501';
  END IF;
  IF p_email_hash IS NULL OR p_email_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid invitation input' USING ERRCODE = '22023';
  END IF;
  IF p_month IS DISTINCT FROM to_char(v_month, 'YYYY-MM') THEN
    RETURN jsonb_build_object('status', 'month_changed', 'expiresAt', NULL);
  END IF;
  INSERT INTO otl.invites (workspace_id, inviter_id, issued_month, email_hash, token_hash, expires_at)
    VALUES (p_workspace, p_actor, v_month, p_email_hash, p_token_hash, v_expires)
    ON CONFLICT (workspace_id, inviter_id, issued_month) DO NOTHING;
  v_inserted := FOUND;
  SELECT * INTO v_invite FROM otl.invites WHERE workspace_id = p_workspace
    AND inviter_id = p_actor AND issued_month = v_month;
  IF v_inserted THEN
    RETURN jsonb_build_object('status', 'issued', 'expiresAt', v_invite.expires_at);
  ELSIF v_invite.email_hash = p_email_hash AND v_invite.token_hash = p_token_hash THEN
    RETURN jsonb_build_object('status', CASE WHEN v_invite.accepted_at IS NULL
      THEN 'existing' ELSE 'used' END, 'expiresAt', v_invite.expires_at);
  END IF;
  RETURN jsonb_build_object('status', 'quota_used', 'expiresAt', NULL);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Invitation conflict' USING ERRCODE = '22023';
END;
$$;

CREATE FUNCTION otl.redeem_invite(
  p_workspace text, p_user text, p_email_hash text, p_token_hash text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE
  v_invite otl.invites%ROWTYPE;
BEGIN
  IF p_workspace IS NULL OR length(btrim(p_workspace)) = 0
     OR p_user IS NULL OR length(btrim(p_user)) = 0
     OR p_email_hash IS NULL OR p_email_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace || ':' || p_email_hash, 0));
  IF EXISTS (SELECT 1 FROM otl.memberships
    WHERE workspace_id = p_workspace AND user_id = p_user) THEN
    RETURN jsonb_build_object('status', 'already_joined');
  END IF;
  SELECT * INTO v_invite FROM otl.invites
    WHERE workspace_id = p_workspace AND token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid');
  ELSIF v_invite.email_hash <> p_email_hash THEN
    RETURN jsonb_build_object('status', 'wrong_recipient');
  ELSIF v_invite.accepted_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM otl.invites WHERE workspace_id = p_workspace
      AND email_hash = p_email_hash AND accepted_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('status', 'invalid');
  ELSIF v_invite.expires_at <= current_timestamp THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;
  INSERT INTO otl.memberships (workspace_id, user_id, invited_by)
    VALUES (p_workspace, p_user, v_invite.inviter_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_joined');
  END IF;
  UPDATE otl.invites SET accepted_by = p_user, accepted_at = current_timestamp
    WHERE workspace_id = p_workspace AND token_hash = p_token_hash;
  RETURN jsonb_build_object('status', 'joined');
END;
$$;

CREATE FUNCTION otl.check_invite(p_workspace text, p_actor text, p_email_hash text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, otl AS $$
DECLARE
  v_invite otl.invites%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM otl.memberships WHERE workspace_id = p_workspace
    AND user_id = p_actor AND invited_by IS NULL) THEN
    RAISE EXCEPTION 'Founder permission required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invite FROM otl.invites WHERE workspace_id = p_workspace
    AND email_hash = p_email_hash AND expires_at > current_timestamp AND accepted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM otl.invites accepted WHERE accepted.workspace_id = p_workspace
      AND accepted.email_hash = p_email_hash AND accepted.accepted_at IS NOT NULL)
    ORDER BY issued_month DESC, inviter_id LIMIT 1;
  RETURN jsonb_build_object('valid', v_invite.inviter_id IS NOT NULL,
    'inviterId', v_invite.inviter_id, 'expiresAt', v_invite.expires_at);
END;
$$;

COMMIT;
