# CPA Stack Glossary

## CPA Stack

The complete locally operated system consisting of CPA, Keeper, and their persistent state.

## CPA

CLIProxyAPI, the service that accepts client requests, selects an eligible provider credential, forwards requests to an upstream provider, and exposes management and usage capabilities.

## Keeper

CPA Usage Keeper, the service that ingests and retains CPA usage information and presents usage analytics and a management dashboard.

## Provider credential

An OAuth record, API credential, or equivalent authorization that CPA uses when communicating with an upstream provider.

A provider credential is distinct from a client API key.

## Client API key

A credential presented by a client when calling CPA.

A client API key authorizes downstream access to CPA; it is not an upstream provider credential and does not grant management access.

## Management key

The privileged credential required to access CPA's management capabilities. Keeper uses this credential when integrating with CPA.

## Keeper login password

The credential a person uses to access Keeper's web interface. It is distinct from the CPA management key.

## Usage feed

Usage information exposed by CPA for ingestion by Keeper. In this stack, the usage feed does not imply a separate Redis service.

## Plugin

An optional extension loaded by CPA to add or alter provider, routing, management, or related behavior.

## Upstream baseline

The configuration published for a specific CPA release before any CPA Stack customization is applied.

## Stack override

CPA Stack configuration layered over the upstream baseline to express stack policy and references to operator-supplied values.

## Effective config

The complete CPA configuration produced by applying the stack override and resolving operator-supplied values against the upstream baseline. CPA consumes the effective config at runtime.
