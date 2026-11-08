(module
  ;; Linear memory: 1 page (64 KiB)
  ;; Offset 0..15  : resolve_capsules output [x1, z1, x2, z2] (4 x f32)
  ;; Offset 16..23 : step_juggle_physics output [y, vy] (2 x f32)
  (memory (export "memory") 1)

  ;; Helper: clamp f32 between lo and hi
  (func $clamp (param $v f32) (param $lo f32) (param $hi f32) (result f32)
    (f32.min (local.get $hi) (f32.max (local.get $lo) (local.get $v)))
  )

  ;; 1. 3D Fighter Capsule Separation & Arena Boundary Clamping
  ;; Writes [x1, z1, x2, z2] to byte offset 0..12.
  ;; Returns bitmask: bit0 = P1 at X wall, bit1 = P2 at X wall.
  (func (export "resolve_capsules")
    (param $x1 f32) (param $z1 f32)
    (param $x2 f32) (param $z2 f32)
    (param $min_dist f32) (param $half_w f32) (param $half_d f32)
    (result i32)
    (local $dx f32)
    (local $dz f32)
    (local $dist_sq f32)
    (local $dist f32)
    (local $overlap f32)
    (local $nx f32)
    (local $nz f32)
    (local $wall_mask i32)

    (local.set $dx (f32.sub (local.get $x2) (local.get $x1)))
    (local.set $dz (f32.sub (local.get $z2) (local.get $z1)))
    (local.set $dist_sq
      (f32.add
        (f32.mul (local.get $dx) (local.get $dx))
        (f32.mul (local.get $dz) (local.get $dz))
      )
    )

    (if (f32.lt (local.get $dist_sq) (f32.mul (local.get $min_dist) (local.get $min_dist)))
      (then
        (local.set $dist (f32.sqrt (local.get $dist_sq)))
        (if (f32.lt (local.get $dist) (f32.const 0.0001))
          (then
            (local.set $nx (f32.const 1.0))
            (local.set $nz (f32.const 0.0))
            (local.set $overlap (f32.mul (local.get $min_dist) (f32.const 0.5)))
          )
          (else
            (local.set $nx (f32.div (local.get $dx) (local.get $dist)))
            (local.set $nz (f32.div (local.get $dz) (local.get $dist)))
            (local.set $overlap (f32.mul (f32.sub (local.get $min_dist) (local.get $dist)) (f32.const 0.5)))
          )
        )
        (local.set $x1 (f32.sub (local.get $x1) (f32.mul (local.get $nx) (local.get $overlap))))
        (local.set $z1 (f32.sub (local.get $z1) (f32.mul (local.get $nz) (local.get $overlap))))
        (local.set $x2 (f32.add (local.get $x2) (f32.mul (local.get $nx) (local.get $overlap))))
        (local.set $z2 (f32.add (local.get $z2) (f32.mul (local.get $nz) (local.get $overlap))))
      )
    )

    ;; Clamp to 3D stage bounds
    (local.set $x1 (call $clamp (local.get $x1) (f32.neg (local.get $half_w)) (local.get $half_w)))
    (local.set $x2 (call $clamp (local.get $x2) (f32.neg (local.get $half_w)) (local.get $half_w)))
    (local.set $z1 (call $clamp (local.get $z1) (f32.neg (local.get $half_d)) (local.get $half_d)))
    (local.set $z2 (call $clamp (local.get $z2) (f32.neg (local.get $half_d)) (local.get $half_d)))

    (local.set $wall_mask (i32.const 0))
    (if (f32.ge (f32.abs (local.get $x1)) (f32.sub (local.get $half_w) (f32.const 0.04)))
      (then (local.set $wall_mask (i32.or (local.get $wall_mask) (i32.const 1))))
    )
    (if (f32.ge (f32.abs (local.get $x2)) (f32.sub (local.get $half_w) (f32.const 0.04)))
      (then (local.set $wall_mask (i32.or (local.get $wall_mask) (i32.const 2))))
    )

    (f32.store (i32.const 0) (local.get $x1))
    (f32.store (i32.const 4) (local.get $z1))
    (f32.store (i32.const 8) (local.get $x2))
    (f32.store (i32.const 12) (local.get $z2))
    (local.get $wall_mask)
  )

  ;; 2. True 3D Limb Hitbox, Sidestep Evasion & High/Low Crush Check
  ;; height_code: 0 = low, 1 = mid, 2 = high, 3 = special/unblockable
  (func (export "check_3d_hit")
    (param $ax f32) (param $ay f32) (param $az f32)
    (param $facing f32) (param $reach f32) (param $hit_depth f32)
    (param $height_code i32) (param $tracking i32)
    (param $dx f32) (param $dy f32) (param $dz f32)
    (param $crouching i32) (param $sidestep_frames i32)
    (result i32)
    (local $forward_dist f32)
    (local $z_diff f32)
    (local $max_z f32)

    ;; Check forward reach along fighter facing axis
    (local.set $forward_dist (f32.mul (f32.sub (local.get $dx) (local.get $ax)) (local.get $facing)))
    (if (f32.lt (local.get $forward_dist) (f32.const -0.25))
      (then (return (i32.const 0)))
    )
    (if (f32.gt (local.get $forward_dist) (local.get $reach))
      (then (return (i32.const 0)))
    )

    ;; Check 3D Z-axis depth & sidestep evasion vs homing moves
    (local.set $z_diff (f32.abs (f32.sub (local.get $dz) (local.get $az))))
    (local.set $max_z
      (select
        (f32.mul (local.get $hit_depth) (f32.const 2.25))
        (select
          (f32.mul (local.get $hit_depth) (f32.const 0.68))
          (local.get $hit_depth)
          (i32.gt_s (local.get $sidestep_frames) (i32.const 0))
        )
        (i32.eq (local.get $tracking) (i32.const 1))
      )
    )
    (if (f32.gt (local.get $z_diff) (local.get $max_z))
      (then (return (i32.const 0)))
    )

    ;; Airborne juggle height window
    (if (f32.gt (local.get $dy) (f32.const 0.12))
      (then
        ;; Opponent too high in the air to reach
        (if (f32.gt (local.get $dy) (f32.const 1.95))
          (then (return (i32.const 0)))
        )
        ;; Low attacks whiff against high airborne opponents (low-crush / jump-over)
        (if (i32.and (i32.eq (local.get $height_code) (i32.const 0)) (f32.gt (local.get $dy) (f32.const 0.36)))
          (then (return (i32.const 0)))
        )
        (return (i32.const 1))
      )
    )

    ;; Grounded High-Crush: High attacks (height_code == 2) whiff crouching opponents!
    (if (i32.and (i32.eq (local.get $height_code) (i32.const 2)) (i32.eq (local.get $crouching) (i32.const 1)))
      (then (return (i32.const 0)))
    )

    (i32.const 1)
  )

  ;; 3. Tekken 5 Combo Proration, Counter-Hit, Rage & Ki/Heat Damage Calculator
  (func (export "compute_combo_damage")
    (param $raw f32)
    (param $juggle_hits i32)
    (param $in_rage i32)
    (param $is_counter i32)
    (param $in_heat i32)
    (result i32)
    (local $scale f32)
    (local $dmg f32)
    (local $res i32)

    ;; Proration curve: 1.0 -> 0.70 -> 0.55 -> 0.45 -> 0.35 -> 0.30
    (local.set $scale (f32.const 1.0))
    (if (i32.eq (local.get $juggle_hits) (i32.const 1))
      (then (local.set $scale (f32.const 0.70)))
    )
    (if (i32.eq (local.get $juggle_hits) (i32.const 2))
      (then (local.set $scale (f32.const 0.55)))
    )
    (if (i32.eq (local.get $juggle_hits) (i32.const 3))
      (then (local.set $scale (f32.const 0.45)))
    )
    (if (i32.eq (local.get $juggle_hits) (i32.const 4))
      (then (local.set $scale (f32.const 0.35)))
    )
    (if (i32.ge_s (local.get $juggle_hits) (i32.const 5))
      (then (local.set $scale (f32.const 0.30)))
    )

    (local.set $dmg (f32.mul (local.get $raw) (local.get $scale)))

    (if (i32.eq (local.get $in_rage) (i32.const 1))
      (then (local.set $dmg (f32.mul (local.get $dmg) (f32.const 1.18))))
    )
    (if (i32.eq (local.get $is_counter) (i32.const 1))
      (then (local.set $dmg (f32.mul (local.get $dmg) (f32.const 1.20))))
    )
    (if (i32.eq (local.get $in_heat) (i32.const 1))
      (then (local.set $dmg (f32.mul (local.get $dmg) (f32.const 1.10))))
    )

    (local.set $res (i32.trunc_f32_s (f32.nearest (local.get $dmg))))
    (if (i32.lt_s (local.get $res) (i32.const 1))
      (then (local.set $res (i32.const 1)))
    )
    (local.get $res)
  )

  ;; 4. Juggle Aerial Ballistics & Gravity Scaling
  ;; Writes [new_y, new_vy] at byte offset 16..20. Returns 1 if landed this tick.
  (func (export "step_juggle_physics")
    (param $y f32)
    (param $vy f32)
    (param $gravity f32)
    (param $juggle_hits i32)
    (result i32)
    (local $grav_scale f32)
    (local $ny f32)
    (local $nvy f32)
    (local $landed i32)

    ;; Gravity increases slightly per juggle hit so combos stay tight and realistic
    (local.set $grav_scale
      (f32.add
        (f32.const 1.0)
        (f32.mul (f32.convert_i32_s (local.get $juggle_hits)) (f32.const 0.08))
      )
    )
    (local.set $ny (f32.add (local.get $y) (local.get $vy)))
    (local.set $nvy (f32.sub (local.get $vy) (f32.mul (local.get $gravity) (local.get $grav_scale))))
    (local.set $landed (i32.const 0))

    (if (f32.le (local.get $ny) (f32.const 0.0))
      (then
        (if (f32.gt (local.get $y) (f32.const 0.0))
          (then (local.set $landed (i32.const 1)))
        )
        (local.set $ny (f32.const 0.0))
        (local.set $nvy (f32.const 0.0))
      )
    )

    (f32.store (i32.const 16) (local.get $ny))
    (f32.store (i32.const 20) (local.get $nvy))
    (local.get $landed)
  )

  ;; 5. CPU AI Tactical Move Scorer (Evaluated per candidate move at 60Hz)
  ;; opp_state: 0=idle/walk, 1=attack_startup, 2=attack_recovery, 3=blockstun, 4=hitstun, 5=juggle
  (func (export "score_ai_move")
    (param $dist_x f32)
    (param $dist_z f32)
    (param $opp_state i32)
    (param $opp_crouching i32)
    (param $opp_airborne i32)
    (param $move_reach f32)
    (param $move_startup i32)
    (param $move_damage f32)
    (param $move_height i32)
    (param $is_launcher i32)
    (param $is_homing i32)
    (param $difficulty i32)
    (param $rng_u32 i32)
    (result f32)
    (local $score f32)
    (local $noise f32)

    ;; Base utility from damage vs startup speed
    (local.set $score
      (f32.sub
        (f32.mul (local.get $move_damage) (f32.const 1.35))
        (f32.mul (f32.convert_i32_s (local.get $move_startup)) (f32.const 0.9))
      )
    )

    ;; Range check: heavily penalize moves that will whiff in X
    (if (f32.gt (local.get $dist_x) (f32.add (local.get $move_reach) (f32.const 0.12)))
      (then (local.set $score (f32.sub (local.get $score) (f32.const 85.0))))
      (else (local.set $score (f32.add (local.get $score) (f32.const 24.0))))
    )

    ;; If opponent sidestepped off-axis in Z, reward homing moves!
    (if (f32.gt (local.get $dist_z) (f32.const 0.38))
      (then
        (if (i32.eq (local.get $is_homing) (i32.const 1))
          (then (local.set $score (f32.add (local.get $score) (f32.const 42.0))))
          (else (local.set $score (f32.sub (local.get $score) (f32.const 28.0))))
        )
      )
    )

    ;; Whiff / Recovery punish: reward launchers and high damage!
    (if (i32.and (i32.eq (local.get $opp_state) (i32.const 2)) (i32.ge_s (local.get $difficulty) (i32.const 2)))
      (then
        (if (i32.eq (local.get $is_launcher) (i32.const 1))
          (then (local.set $score (f32.add (local.get $score) (f32.const 45.0))))
        )
      )
    )

    ;; Counter-poke fast startup against opponent startup
    (if (i32.and (i32.eq (local.get $opp_state) (i32.const 1)) (i32.le_s (local.get $move_startup) (i32.const 12)))
      (then (local.set $score (f32.add (local.get $score) (f32.const 32.0))))
    )

    ;; Punish crouching opponent with Mids (1) and avoid Highs (2)!
    (if (i32.eq (local.get $opp_crouching) (i32.const 1))
      (then
        (if (i32.eq (local.get $move_height) (i32.const 1))
          (then (local.set $score (f32.add (local.get $score) (f32.const 35.0))))
        )
        (if (i32.eq (local.get $move_height) (i32.const 2))
          (then (local.set $score (f32.sub (local.get $score) (f32.const 90.0))))
        )
      )
    )

    ;; Juggle continuation when opponent is airborne: use fast mids, avoid lows
    (if (i32.eq (local.get $opp_airborne) (i32.const 1))
      (then
        (if (i32.eq (local.get $move_height) (i32.const 1))
          (then (local.set $score (f32.add (local.get $score) (f32.const 40.0))))
        )
        (if (i32.eq (local.get $move_height) (i32.const 0))
          (then (local.set $score (f32.sub (local.get $score) (f32.const 70.0))))
        )
      )
    )

    ;; Deterministic pseudo-random jitter (larger on lower difficulty so Easy/Medium feel human)
    (local.set $noise
      (f32.mul
        (f32.div
          (f32.convert_i32_u (i32.and (local.get $rng_u32) (i32.const 1023)))
          (f32.const 1023.0)
        )
        (f32.sub (f32.const 36.0) (f32.mul (f32.convert_i32_s (local.get $difficulty)) (f32.const 7.5)))
      )
    )

    (f32.add (local.get $score) (local.get $noise))
  )
)
