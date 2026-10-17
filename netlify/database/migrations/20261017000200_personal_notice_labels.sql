-- Personal presentation labels never mutate the source's access classification.
CREATE TABLE campus_notice_labels (
  owner_id text NOT NULL,
  item_id text NOT NULL,
  categories jsonb NOT NULL CHECK (
    jsonb_typeof(categories)='array' AND jsonb_array_length(categories) BETWEEN 1 AND 7
    AND categories <@ '["school","college","competition","academic","activity","scholarship","mail"]'::jsonb
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,item_id)
);
REVOKE ALL ON campus_notice_labels FROM PUBLIC;
