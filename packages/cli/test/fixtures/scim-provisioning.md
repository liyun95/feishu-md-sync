---
title: "SCIM Provisioning | Cloud"
slug: /scim-provisioning
sidebar_label: "Overview"
---

# SCIM Provisioning

## About SCIM provisioning in Zilliz Cloud

SCIM provisioning in Zilliz Cloud is an identity synchronization workflow between your IdP and your Zilliz Cloud organization. Your IdP acts as the SCIM client and remains the source of truth for users, groups, and group memberships. Zilliz Cloud acts as the SCIM 2.0 server, receives provisioning requests from the IdP, and represents the synced identities in your organization.

![SCIM provisioning workflow in Zilliz Cloud](/img/scim-provisioning-workflow.svg)

## What SCIM syncs from your IdP to Zilliz Cloud

| Area | Synced by SCIM | Where to manage changes |
|---|---|---|
| Users | SCIM creates and updates user records in Zilliz Cloud based on users assigned in the IdP. | Manage which users are provisioned in the IdP. |
| Groups | SCIM syncs group records from the IdP to Zilliz Cloud. | Manage group names and group lifecycle in the IdP. |
